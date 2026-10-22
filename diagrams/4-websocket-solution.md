```mermaid
---
title: "Solution: WebSocket Plugin — Eliminates Client Round Trips"
---
sequenceDiagram
    participant Client as Java Test Client
    participant Internet as ☁️ Internet<br/>(only 2 calls)
    participant Appium as Appium Server
    participant Plugin as data-streamer Plugin
    participant Device as UIA2 Server<br/>(WebSocket :6791)
    participant Android as Android UIAutomator

    Note over Client,Android: ONE call to START (client is done)

    Client->>Internet: executeScript("dataStreamer: startTextCollection",<br/>{name:"price", locator:{...}, intervalMs:200})
    Internet->>Appium: 
    Appium->>Plugin: startTextCollection()
    Plugin->>Device: findElement → elementId
    Plugin->>Device: WS subscribe (element.text, 200ms)
    Device-->>Plugin: ✓ subscribed
    Plugin-->>Appium: ✓ started
    Appium-->>Internet: 
    Internet-->>Client: ✓ started

    Note over Plugin,Android: Data flows LOCALLY on device — no internet hops

    loop Every 200ms (device-side scheduler, zero network latency)
        Device->>Android: element.getText()
        Android-->>Device: "$42.50" ⏱️ <5ms
        Device->>Plugin: WS push {"text":"$42.50"} ⏱️ <1ms
        Plugin->>Plugin: buffer sample with timestamp
    end

    Note over Client: Client free to do other test actions

    Note over Client,Android: ONE call to STOP (get all data back)

    Client->>Internet: executeScript("dataStreamer: stopTextCollection",<br/>{name:"price"})
    Internet->>Appium: 
    Appium->>Plugin: stopTextCollection()
    Plugin->>Device: WS unsubscribe
    Plugin-->>Appium: {samples: [...25 samples...], durationMs: 5000}
    Appium-->>Internet: 
    Internet-->>Client: ✓ all 25 time-mapped samples

    Note over Client,Android: ✅ 2 internet round trips instead of 25+<br/>✅ Samples collected at true 200ms intervals (no jitter)<br/>✅ Accurate timestamps from device clock<br/>✅ Zero missed price ticks
```

## Latency Comparison

| | Local Emulator | HeadSpin (Cloud) |
|---|---|---|
| Single getText() latency | ~20-50ms | ~250-600ms |
| 25 getText() calls (5s @ 200ms) | ~1s overhead, some jitter | **Can't sustain rate** — calls pile up |
| Missed data points | Some | **Most** |
| **With WS plugin (same 25 samples)** | **2 calls × ~40ms = 80ms total overhead** | **2 calls × ~400ms = 800ms total overhead** |
| Data accuracy | ✅ Device-clock timestamps, no gaps | ✅ Same — collection runs on-device |
