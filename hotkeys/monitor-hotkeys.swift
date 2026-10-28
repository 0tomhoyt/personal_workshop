// monitor-hotkeys.swift — 显示器输入源系统级热键守护
//
// 用途：不打开任何浏览器/工作台，按下全局热键（默认 F13，出自 providers.json 的
// monitors.hotkeys，管理台可改绑）即触发网关的「一键切换」（toggle）：同源对切到
// 下一个已配置输入源 / 异源按屏顺序轮换互换。热键绑的是**动作**不是具体输入源值。
// 实现：Carbon RegisterEventHotKey（系统级热键注册，不需要辅助功能权限、无第三方依赖）；
// 按下后对本机网关发 POST /admin/monitors/switch {"mode":"toggle"}。失败只记日志，
// 绝不崩溃、不注销热键。
//
// 配置（与网关同源 providers.json，改绑后无需重启本守护）：
//   路径   CANNBOT_CONFIG_FILE 环境变量，缺省 = 本二进制同目录的 providers.json
//   内容   monitors.hotkeys: [{ "action": "toggle", "key": "f13" }]
//          key 为小写稳定记号：修饰键（cmd/ctrl/opt/alt/shift）加号组合 + 主键（f1-f24/字母/数字）。
//          action 目前支持 "toggle"（与网关 config.mjs 同一集合，其他值跳过不注册）。
//          文件里没写 hotkeys 节时用默认 [{toggle,f13}]（与网关播种口径一致）。
// 热加载：每 3s 查一次配置文件 mtime，变更即注销全部热键并按新表重注册。
// 端口：CANNBOT_PROXY_PORT 环境变量，缺省读本二进制同目录 port 文件（install.sh 写入），再缺省 8484。
// 日志：stdout/stderr（LaunchAgent 重定向到 logs/hotkeys.log）。

import Foundation
import Carbon.HIToolbox

// ---- 小工具 ---------------------------------------------------------------

func log(_ msg: String) {
    let df = DateFormatter()
    df.dateFormat = "yyyy-MM-dd HH:mm:ss"
    print("[\(df.string(from: Date()))] \(msg)")
    fflush(stdout)
}

func binaryDir() -> String {
    let exe = CommandLine.arguments[0]
    let url = URL(fileURLWithPath: exe).deletingLastPathComponent()
    return url.path
}

func configPath() -> String {
    if let p = ProcessInfo.processInfo.environment["CANNBOT_CONFIG_FILE"], !p.isEmpty { return p }
    return binaryDir() + "/providers.json"
}

func gatewayPort() -> Int {
    if let s = ProcessInfo.processInfo.environment["CANNBOT_PROXY_PORT"], let p = Int(s), p > 0 { return p }
    let portFile = binaryDir() + "/port"
    if let s = try? String(contentsOfFile: portFile, encoding: .utf8),
       let p = Int(s.trimmingCharacters(in: .whitespacesAndNewlines)), p > 0 { return p }
    return 8484
}

// ---- key 记号解析：修饰键组合 + 主键 → (modifiers, keyCode) -----------------

let modifierNames: [String: UInt32] = [
    "cmd": UInt32(cmdKey), "command": UInt32(cmdKey),
    "ctrl": UInt32(controlKey), "control": UInt32(controlKey),
    "opt": UInt32(optionKey), "option": UInt32(optionKey), "alt": UInt32(optionKey),
    "shift": UInt32(shiftKey),
]

let keyCodes: [String: Int] = {
    var m: [String: Int] = [:]
    let fKeys: [(String, Int)] = [
        ("f1", kVK_F1), ("f2", kVK_F2), ("f3", kVK_F3), ("f4", kVK_F4), ("f5", kVK_F5),
        ("f6", kVK_F6), ("f7", kVK_F7), ("f8", kVK_F8), ("f9", kVK_F9), ("f10", kVK_F10),
        ("f11", kVK_F11), ("f12", kVK_F12), ("f13", kVK_F13), ("f14", kVK_F14),
        ("f15", kVK_F15), ("f16", kVK_F16), ("f17", kVK_F17), ("f18", kVK_F18),
        ("f19", kVK_F19), ("f20", kVK_F20),
    ]
    for (k, c) in fKeys { m[k] = Int(c) }
    let letters = "abcdefghijklmnopqrstuvwxyz"
    for ch in letters { m[String(ch)] = Int(CHelpers.keyCode(for: String(ch))) }
    for d in 0...9 { m[String(d)] = Int(CHelpers.keyCode(for: String(d))) }
    return m
}()

// 字母/数字 → kVK_ANSI_* keyCode（US 布局表）
enum CHelpers {
    static func keyCode(for ch: String) -> Int32 {
        switch ch {
        case "a": return Int32(kVK_ANSI_A); case "b": return Int32(kVK_ANSI_B)
        case "c": return Int32(kVK_ANSI_C); case "d": return Int32(kVK_ANSI_D)
        case "e": return Int32(kVK_ANSI_E); case "f": return Int32(kVK_ANSI_F)
        case "g": return Int32(kVK_ANSI_G); case "h": return Int32(kVK_ANSI_H)
        case "i": return Int32(kVK_ANSI_I); case "j": return Int32(kVK_ANSI_J)
        case "k": return Int32(kVK_ANSI_K); case "l": return Int32(kVK_ANSI_L)
        case "m": return Int32(kVK_ANSI_M); case "n": return Int32(kVK_ANSI_N)
        case "o": return Int32(kVK_ANSI_O); case "p": return Int32(kVK_ANSI_P)
        case "q": return Int32(kVK_ANSI_Q); case "r": return Int32(kVK_ANSI_R)
        case "s": return Int32(kVK_ANSI_S); case "t": return Int32(kVK_ANSI_T)
        case "u": return Int32(kVK_ANSI_U); case "v": return Int32(kVK_ANSI_V)
        case "w": return Int32(kVK_ANSI_W); case "x": return Int32(kVK_ANSI_X)
        case "y": return Int32(kVK_ANSI_Y); case "z": return Int32(kVK_ANSI_Z)
        case "0": return Int32(kVK_ANSI_0); case "1": return Int32(kVK_ANSI_1)
        case "2": return Int32(kVK_ANSI_2); case "3": return Int32(kVK_ANSI_3)
        case "4": return Int32(kVK_ANSI_4); case "5": return Int32(kVK_ANSI_5)
        case "6": return Int32(kVK_ANSI_6); case "7": return Int32(kVK_ANSI_7)
        case "8": return Int32(kVK_ANSI_8); case "9": return Int32(kVK_ANSI_9)
        case "space": return Int32(kVK_Space); case "return": return Int32(kVK_Return)
        default: return -1
        }
    }
}

struct HotkeySpec {
    let action: String
    let key: String
    var modifiers: UInt32
    var keyCode: Int
}

// 支持的动作集合（与网关 config.mjs / monitors-admin.mjs 同一集合）
let knownActions: Set<String> = ["toggle"]

// 解析单条记号；解析失败返回 nil（该条跳过，其余照常注册）
func parseHotkey(_ action: String, _ key: String) -> HotkeySpec? {
    let parts = key.lowercased().split(separator: "+").map(String.init)
    guard parts.count >= 1 else { return nil }
    var mods: UInt32 = 0
    for p in parts.dropLast() {
        guard let m = modifierNames[p] else { return nil }
        mods |= m
    }
    guard let code = keyCodes[parts.last!], code >= 0 else { return nil }
    return HotkeySpec(action: action, key: key, modifiers: mods, keyCode: code)
}

// ---- 读配置：monitors.hotkeys（缺省播种默认，与网关同一口径） ----------------

func loadHotkeys() -> [HotkeySpec] {
    let defaults: [(action: String, key: String)] = [("toggle", "f13")]
    let path = configPath()
    guard let data = FileManager.default.contents(atPath: path),
          let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
          let monitors = obj["monitors"] as? [String: Any] else {
        return defaults.compactMap { parseHotkey($0.action, $0.key) }
    }
    let entries = (monitors["hotkeys"] as? [[String: Any]]) ?? []
    if entries.isEmpty && monitors["hotkeys"] == nil { // 没写 hotkeys 节 → 默认
        return defaults.compactMap { parseHotkey($0.action, $0.key) }
    }
    var specs: [HotkeySpec] = []
    var seenKey = Set<String>()
    for e in entries {
        guard let action = e["action"] as? String, knownActions.contains(action),
              let key = e["key"] as? String,
              let spec = parseHotkey(action, key), !seenKey.contains(key) else { continue }
        seenKey.insert(key)
        specs.append(spec)
    }
    return specs
}

// ---- 热键注册与回调 --------------------------------------------------------

var registered: [(EventHotKeyRef, EventHotKeyID)] = []
let signature: OSType = 0x63677068 // 'cgph' cannbot-gateway-proxy hotkeys
var nextId: UInt32 = 1

func unregisterAll() {
    for (ref, _) in registered { UnregisterEventHotKey(ref) }
    registered = []
    nextId = 1
}

func triggerAction(_ action: String) {
    let port = gatewayPort()
    guard let url = URL(string: "http://127.0.0.1:\(port)/admin/monitors/switch") else { return }
    var req = URLRequest(url: url)
    req.httpMethod = "POST"
    req.setValue("application/json", forHTTPHeaderField: "content-type")
    req.timeoutInterval = 15
    req.httpBody = try? JSONSerialization.data(withJSONObject: ["mode": action])
    let task = URLSession.shared.dataTask(with: req) { _, response, error in
        if let error = error {
            log("热键触发失败（\(action)）: \(error.localizedDescription)")
        } else if let http = response as? HTTPURLResponse, http.statusCode >= 400 {
            log("热键触发被网关拒绝（\(action)，HTTP \(http.statusCode)）")
        } else {
            log("热键已触发 \(action)（一键切换）")
        }
    }
    task.resume()
}

func hotkeyHandler(_ nextHandler: EventHandlerCallRef?, _ event: EventRef?, _ userData: UnsafeMutableRawPointer?) -> OSStatus {
    guard let event = event else { return noErr }
    var id = EventHotKeyID()
    guard GetEventParameter(event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID),
                            nil, MemoryLayout<EventHotKeyID>.size, nil, &id) == noErr else { return noErr }
    // idID 即注册时分配的序号，映射回动作
    let seq = id.id
    if let spec = currentSpecs.first(where: { $0.id == seq }) {
        triggerAction(spec.spec.action)
    }
    return noErr
}

// 给注册中的条目带上序号（回调按序号找回动作）
struct RegSpec { let id: UInt32; let action: String; let spec: HotkeySpec }
var currentSpecs: [RegSpec] = []

func registerAll() {
    let specs = loadHotkeys()
    unregisterAll()
    var installed: [RegSpec] = []
    for spec in specs {
        var ref: EventHotKeyRef?
        let hotId = EventHotKeyID(signature: signature, id: nextId)
        if RegisterEventHotKey(UInt32(spec.keyCode), spec.modifiers, hotId,
                               GetApplicationEventTarget(), 0, &ref) == noErr, let ref = ref {
            registered.append((ref, hotId))
            installed.append(RegSpec(id: nextId, action: spec.action, spec: spec))
            nextId += 1
        } else {
            log("热键注册失败: \(spec.key)（可能被其他应用占用）")
        }
    }
    currentSpecs = installed
    log("已注册热键: \(installed.map { "\($0.spec.key)=\($0.action)" }.joined(separator: "、"))（配置: \(configPath())）")
}

// ---- main：装事件处理器 → 注册 → mtime 轮询热加载 ---------------------------

var lastMtime: Date? = nil

func configMtime() -> Date? {
    (try? FileManager.default.attributesOfItem(atPath: configPath()))?[.modificationDate] as? Date
}

// 事件处理器只装一次（类型签名固定的 C 函数指针）
var eventType = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
var handler: EventHandlerRef?
InstallEventHandler(GetApplicationEventTarget(), hotkeyHandler, 1, &eventType, nil, &handler)

registerAll()
lastMtime = configMtime()

// 每 3s 查 mtime：变了就整表重注册（管理台改绑 → 写盘 → 这里自动生效）
Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { _ in
    let mtime = configMtime()
    if mtime != lastMtime {
        log("检测到配置变更，重载热键…")
        lastMtime = mtime
        registerAll()
    }
}

log("monitor-hotkeys 守护已启动（网关端口 \(gatewayPort())）")
RunLoop.main.run()
