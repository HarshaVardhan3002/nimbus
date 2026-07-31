# Nimbus — architecture

Windows-native agentic overlay. Electron 43 main process, two independently
clipped OS windows, DWM acrylic via direct Win32 calls, provider-agnostic LLM
transport with local-first defaults.

---

## 1. Window topology

The single most important structural change. Before, one 700x600 transparent
window held everything and faked click-through in JavaScript.

```
                    ┌──────────────────────────┐
   pill window ───► │  ●  Listening  ▮▮▮  🎤 ⌄ │   own HWND, own region
                    └──────────────────────────┘
                              ↕ 10px             ← no window here at all
                    ┌──────────────────────────┐
   panel window ──► │                          │   own HWND, own region
                    │   messages / composer    │   height sprung to content
                    │                          │
                    └──────────────────────────┘
```

### Why two windows

| Problem in the old build | Why one window could not fix it | How two windows fix it |
|---|---|---|
| Clicks in the gap between pill and panel hit the app | The gap is inside the window rect. `elementFromPoint` on `mousemove` toggling `setIgnoreMouseEvents` is a heuristic racing the user's cursor | There is no window in the gap. The click goes to whatever is underneath because nothing is there |
| Hiding the chat left an invisible click-blocking rectangle | `#panel.collapsed { display: none }` hides pixels; the 700x600 window still exists and still hit-tests | `panelWin.hide()` removes the window from the OS hit-test tree on the same tick |
| Click-through re-enable could miss its own wake-up | While a window ignores the mouse it stops receiving reliable `mousemove`, so the handler that re-enables it may never run | No hit-testing JS exists at all |

Both are structural guarantees enforced by the OS, not best-effort JS.

### Pixel-exact bounds

Two mechanisms working together:

1. **Content measurement.** A `ResizeObserver` in each renderer reports the
   measured size of the root element over IPC. The pill reports width (height
   fixed); the panel reports height (width fixed). Fixing one axis per window is
   what prevents a measure/resize feedback loop.
2. **Region clipping.** `SetWindowRgn` with a `CreateRoundRectRgn` clips the
   window — and therefore its hit-test area — to the exact rounded shape. A
   click one pixel outside the visible rounded corner is not delivered to Nimbus
   at all.

> **DPI:** Electron bounds are DIPs, GDI regions are device pixels. On a 150%
> display a 640 DIP window is 960 px. `manager._applyRegion()` multiplies by
> `scaleFactor` before calling into GDI. Skipping this conversion is the most
> common way this technique is gotten wrong, and it silently slices a third off
> the panel.

---

## 2. Native layer (`src/native/win32.js`)

### Why the old glass was fake

`backdrop-filter: blur(40px)` inside a **transparent** Electron window does not
blur the desktop. It composites DOM content in the same layer tree, and behind
an overlay panel there is none. The old build's "liquid glass" was
`rgba(20,22,28,0.72)` — a flat dark rectangle.

### Why not `backgroundMaterial: 'acrylic'`

Electron's documented Win11 route is mutually exclusive with `transparent: true`
(guidance is an opaque window with a `#00000000` background colour instead).
Going opaque costs per-pixel alpha, which costs antialiased rounded corners,
which is the entire look. It also has open issues around maximize, Windows 10,
and the Energy Saver setting greying the surface out.

### What we do instead

`SetWindowCompositionAttribute(WCA_ACCENT_POLICY)` with
`ACCENT_ENABLE_ACRYLICBLURBEHIND`, called through **koffi** FFI. This gives real
DWM blur on a per-pixel-alpha window, which is what native Windows glass apps
do. CSS then layers on only what DWM cannot: rim light, edge refraction, a
cursor-tracked specular sheen, and the tint gradient.

### Drag mode

DWM re-samples the acrylic backdrop every frame a window moves, and the
well-known result is rubber-banding. On drag start the layer swaps down to
`ACCENT_ENABLE_BLURBEHIND` (cheap gaussian) and swaps back on release.

### Fallback chain

Nothing in `win32.js` may throw. Every export degrades to a no-op:

```
koffi loads?          no ──► html.no-native → CSS backdrop-filter + opaque fill
  │ yes
Windows >= 10.0.17134? no ──► same fallback
  │ yes
each syscall individually try/caught ──► partial degradation, app still runs
```

`native:status` exposes this to both renderers; the settings panel reports it.

---

## 3. Motion (`src/spring.js`)

Window bounds cannot be animated by CSS, so the spring is integrated in the main
process and drives `setBounds` per frame.

A damped harmonic oscillator, not a bezier: a bezier is a fixed-duration curve,
so interrupting it mid-flight either snaps or restarts. A spring carries
velocity across a retarget, which is why the panel resizing while it is still
opening blends instead of stuttering.

Semi-implicit Euler at a **fixed 1/240s substep**. Fixed substeps matter: a
variable `dt` makes stiff springs diverge when a frame is dropped, and dropped
frames are guaranteed the first time an LLM stream saturates IPC. Catch-up is
clamped at 250ms.

Measured:

| preset | settle | overshoot | used for |
|---|---|---|---|
| `emerge` | 367ms | 1.40% | panel opening |
| `resize` | 333ms | 0.00% | content growing/shrinking while open |
| `collapse` | 208ms | 0.00% | available; panel close is immediate |

> **Non-obvious result:** critically damped (ζ = 1.0) is *not* fastest to
> settle. Its response carries a `(1 + ω₀t)` polynomial term alongside the
> exponential, so reaching a tight tolerance takes longer than a slightly
> underdamped system at the same ω₀. A ζ = 1.0 collapse preset measured 325ms;
> ζ = 0.91 with higher ω₀ measured 208ms at <0.2% overshoot.

Rest thresholds are 0.5 px and 60 px/s. 60 px/s is half a pixel per frame at
120Hz — below the point another frame could change the screen. An earlier
0.4 px/s cutoff made the spring chase an invisible exponential tail and measured
617ms for an animation that visually finished at ~300ms.

**Panel close is deliberately not animated.** An animated collapse means the
window keeps eating clicks in a region that already looks empty for the duration
of the tween. `hide()` fires first.

### Drag

Polled in the main process at 8ms via `screen.getCursorScreenPoint()`, not
driven by renderer `mousemove` IPC. One message per mouse move at 1000Hz on a
gaming mouse saturates the channel and the window visibly lags the cursor; and
both windows must move on the *same* tick or they visibly separate.

---

## 4. Provider registry (`src/providers.js`)

The old build hardcoded four providers in three places (an array in `store.js`,
four `<button>` tags in HTML, an if/else chain in `llm.js`). Missing one failed
silently.

Everything OpenAI-compatible collapses to one transport with a different
`baseURL` — which is already how the old `nvidia` entry worked, it just was
never generalised.

```
kind: 'openai'     ──► OpenAI · NVIDIA · Ollama · LM Studio · vLLM ·
                       llama.cpp · TabbyAPI · OpenRouter · Groq · custom
kind: 'anthropic'  ──► Anthropic
kind: 'gemini'     ──► Google
```

### The readiness bug

Old gate: `ready: !!apiKey && !!model`.

Ollama and llama.cpp have no API key, so a keyless local provider could **never
become ready** — the state was unreachable. Corrected to:

```js
keySatisfied = provider.needsKey ? hasKey : true
ready        = keySatisfied && !!model
```

`NO_KEY = 'cue-local'` is passed to the OpenAI SDK for keyless endpoints,
because the SDK constructor throws on an empty `apiKey` even when the server
ignores auth entirely.

### Model discovery

`GET {baseURL}/models`, run in the **main process**. The renderer CSP is
`default-src 'self'`, so a renderer-side fetch to `http://127.0.0.1:11434`
would be silently blocked.

### Vision gating

Vision is a property of a **model**, not of a provider. One OpenAI-compatible
endpoint routinely serves a vision model and a text-only one side by side, so a
single per-provider flag cannot describe it — and when it was tried, a capable
model was stamped text-only and every screen question went out blind.

`settings.modelInfo` caches capabilities keyed `"<providerId>::<modelId>"`.
`providers.visionFor()` answers **true / false / null**, and `null` genuinely
means unknown:

| source   | how it was learned                        | rank |
| -------- | ----------------------------------------- | ---- |
| `user`   | an override in advanced settings          | 3    |
| `probe`  | a real request the model accepted or not  | 2    |
| `server` | declared by `/v1/models`                  | 1    |
| `guess`  | the model name looked like it             | 0    |

Weaker evidence cannot overwrite stronger, except through a user-initiated
Refresh, which passes `override` so a stale probe result can be cleared.

The resulting flow is optimistic: a screen question first asks the server what
the model can do (usually decisive, and cached), attaches the screenshot unless
the model is *known* blind, and — if the request is rejected for the image —
retries once without it and records `vision: false` for that model alone. A
wrong guess therefore costs one retry once; the old behaviour cost a wrong
answer every time, silently.

`routes.vision` remains as an explicit hand-off for the case where the chat
model genuinely cannot see and screen questions should go elsewhere.

Typed questions never carry a screenshot at all (`MODES.ask.needsScreen` is
`false`). They used to, which meant every self-contained question paid for a
capture and — on a text-only route — produced a rejection banner about an image
the user never asked to send.

---

## 5. Audio and STT

### The old pipeline

```
every 128-sample block ──IPC──► main ──► setInterval(3500ms) ──► one RMS gate ──► Whisper
```

Minimum latency before transcription *started* was up to 3.5s. One gate over a
3.5s window meant a cough dragged silence through, and a quiet sentence inside a
loud window was discarded wholesale. Utterances were cut at wall-clock
boundaries, so words split across two requests and both halves transcribed wrong.

### The new pipeline

```
AudioWorklet (20ms frames)
  ├─ adaptive noise floor  (rises slow, falls fast)
  ├─ hysteresis            (enter 3x floor, exit 0.6x enter)
  ├─ pre-roll ring         (300ms, so the onset is not clipped)
  └─ hangover              (550ms of silence = utterance over)
        │
        └─► on speech-end: post the whole utterance (transferred, not cloned)
              └─► main: serialised STT queue ──► transcript ──► wake-word check
```

Latency is now bounded by the hangover, not a clock tick.

STT requests are serialised through a promise chain: a local Whisper server is
usually single-slot, and parallel requests queue internally while burning three
timeouts. Ordering also matters for the transcript to read correctly.

**Honest limitation:** this is an energy VAD, not a neural one. It is a large
improvement over a 3.5s interval but will still trigger on non-speech
transients. `VadProcessor._classify()` is deliberately isolated so a Silero ONNX
session can replace it without touching the buffering logic.

**Wake word** matches on the transcript, not raw audio, so it costs no extra
model and works with any STT backend. The honest tradeoff: it fires after an
utterance completes and transcribes, so it is about as fast as the STT round
trip, not instant. True always-on KWS (openWakeWord, Porcupine) would need a
per-frame model in the worklet — the `_classify()` hook is where it slots in.

### Local Whisper

The local path speaks OpenAI's `/v1/audio/transcriptions` wire format over
plain `fetch` + `FormData`. That one code path covers faster-whisper-server,
whisper.cpp's server, Speaches and LM Studio. Running Whisper locally needs no
native module, no Python bridge, no rebuild step — it is a base URL.

### System audio

`setDisplayMediaRequestHandler` returns a screen source with `audio: 'loopback'`,
capturing whatever is playing without a virtual audio cable. This is the one
place Windows is genuinely easier than macOS, where loopback needs a kernel
extension. It is what makes live translation of on-screen media work.

### 5.1 The mic is not symmetric with system audio

The two channels used to be one switch each, both defaulting to on. That is the
wrong shape for what this app is mostly used for. Transcribing or translating a
video, a call or a lecture playing on this machine wants the `them` channel and
*only* the `them` channel — the mic contributes the user's own room, keyboard
and breathing, folded into the same transcript the model then reasons over.

So `audio.micMode` replaces `audio.captureMic`:

| mode | device opened? | audio reaches STT |
|---|---|---|
| `ptt` (default) | yes, at listen start | only while the talk chord or the pill's talk button is held |
| `always` | yes | for as long as Nimbus is listening |
| `off` | **no** — `getUserMedia` is never called | never |

`them` keeps a plain on/off (`audio.captureSystem`), because it *is* ambient: if
you turned listening on, you want what is playing transcribed.

#### Where the gate lives

In the **worklet**, not the page:

```
mic device (open) ──► VadProcessor.process()
                        │
                        ├─ gate closed ──► frame discarded on the audio thread
                        │                  (accLen reset; no rms, no pre-roll,
                        │                   no utterance, no level)
                        └─ gate open ────► normal VAD path
```

Gating at the frame boundary means a closed gate is audio that was thrown away
the moment it arrived, rather than audio sitting buffered somewhere waiting for
a later check to drop it.

The main process enforces the same rule a second time on `audio:utterance`. It
is deliberately redundant: "the mic was shut, therefore the model never heard
it" is the promise the feature makes, and a promise enforced in exactly one
place is enforced until the next refactor moves that place.

#### The device stays open

`ptt` opens the mic device at listen start and leaves it open, gated. Opening it
per key press instead costs 150–400ms of `getUserMedia` on a cold device, which
eats the first word of every sentence — and a push-to-talk button that reliably
loses your first word is not a push-to-talk button.

The visible cost is that Windows shows its microphone-in-use indicator for the
whole session. That is the honest signal: the device really is open. `off` is
there for anyone who wants it dark, and it is the only mode where the indicator
can be trusted to mean nothing is happening.

#### Why hold-to-talk is a poll

`globalShortcut` is press-only. It has no key-up event, so "open the mic while
this is held" cannot be expressed with it at all. The two ways to get a real
hold on Windows:

| approach | verdict |
|---|---|
| `WH_KEYBOARD_LL` hook | Sees every keystroke in every application. Indistinguishable from a keylogger to the user and to their AV. Wrong trade for a feature whose purpose is reducing what the app hears |
| Poll `GetAsyncKeyState` for one chord | Reads only the two or three virtual keys the user themselves bound. Installs nothing, observes no key content |

`src/pushtotalk.js` polls, at 24ms — finer than human release timing is
resolvable, and the app already polls the cursor at 8ms to drive window drag.

One subtlety worth recording: `GetAsyncKeyState`'s **bit 0** is "pressed since
the last call to this function" and clears on read. Polling on it makes a held
key read as released on the very next tick. Bit 15 is the one that means
currently-down.

With no native layer there is no key-up to be had, so the chord degrades to a
`globalShortcut` **latch** — press to open, press again to close — and reports
itself as `latch` rather than `hold` through `native:status`, so the settings
screen can say which control the user actually has.

#### The release grace window

The VAD emits an utterance when the speaker *stops*, and users release the key
at roughly that moment — frequently a few hundred ms before, because the 550ms
hangover has not elapsed yet. A gate check with no tolerance would therefore
transcribe the last sentence of every push-to-talk turn and then discard it.

Two mechanisms, because either alone is wrong:

1. Closing the gate **flushes** the worklet: the buffer at the instant of
   release holds exactly the words the key was held for.
2. Main accepts a `you` utterance for `MIC_RELEASE_GRACE_MS` (2.5s) after close.

#### One owner for the gate

Three inputs — the configured mode, the global chord, and the pill's talk button
— collapse to one boolean in the main process, which broadcasts `mic:gate`. The
renderer applies it to the worklet and the STT intake enforces it. "Was the mic
open when this audio was captured" therefore has a single answer instead of two
that can disagree.

---

## 6. IPC surface

`contextIsolation: true`, `nodeIntegration: false`, explicit allowlists in both
directions. `scripts/check.js` enforces parity — every channel a renderer sends
has a main-process handler, every channel a renderer listens for is in the
preload `INBOUND` list.

```
renderer ──► main   settings:get/set · providers:list/discover/test · native:status
                    history:list/search/count/load/new/rename/delete/clear/current
                    ask · ask:abort · audio:utterance · listen:state · mic:hold
                    ui:pill-size · ui:panel-size · ui:toggle-panel
                    ui:drag-start · ui:drag-end · ui:open-help · ui:status · log

main ──► renderer   panel:state · llm:start/token/reasoning/done/error · status
                    transcript · settings:changed · listen:request · mic:gate
                    panel:focus-input · open-settings · display:changed
                    glass:changed · warmth:state · stealth:state
                    history:changed · history:opened
```

---

## 7. Verification

```
npm run check     # syntax, control-byte hygiene, IPC parity, inbound allowlist,
                  # dead-API scan, single-setBounds geometry invariant,
                  # renderer-vs-markup selector agreement, asset resolution,
                  # package/asar config, registry-vs-store coherence,
                  # and the storage seam (§12.3)
```

The dead-API scan strips comments before matching and uses word boundaries.
Both matter here: much of this refactor's documentation names the APIs it
removed, and `openPane` is a prefix of the very much alive `openPanel`.

---

## 8. Bugs found in first-run testing

All five were found by measuring on a real 3840x2160 @ 250% Windows 11 machine
(build 26200). Four were invisible at 100% scaling.

### 8.1 Content protection made the window render nowhere

`setContentProtection(true)` (WDA_EXCLUDEFROMCAPTURE) combined with
`transparent: true` dropped the window out of DWM's per-pixel-alpha composition
path entirely. The HWND reported `IsWindowVisible = true` with correct bounds
and a correct region, and nothing was drawn -- not to the screen, not to
screenshots. Supported API, supported build, still broken in combination.

Now opt-in via `ui.stealth` (default off) with a warning in Settings.

> This also made the app un-screenshottable during debugging, which is correct
> behaviour for the feature and very confusing when you have forgotten it is on.

### 8.2 The panel measured itself inside a 1px viewport

The panel window was created 1px tall while hidden, and `#messages` capped
itself with `max-height: 44vh`. In a 1px viewport that is 0.44px, so the
ResizeObserver reported a collapsed panel and the window was sized to match.

The general rule: **a window that is sized from its content cannot use
viewport-relative units for that content.** It is a circular definition. Fixed
by pushing the display work-area height in as `--avail-h` from the main process,
which does not depend on the window at all.

### 8.3 `[].every()` returns true, so the animation loop never ran

`SpringLoop.settled` was `this.springs.every(s => s.atRest)`. `loop.add()` was
never called, so `springs` was empty -- and `every()` on an empty array is
vacuously **true**. The loop reported itself settled on its first tick and
stopped. The panel was set to its start height and never advanced, so it sat at
whatever minimum height Windows would honour (~36px).

Fixed with a `length > 0` guard plus the missing `add()`. Regression test
asserts an empty loop is not settled.

### 8.4 Drag creep: readback compounding

Reported symptom: *"the bounding box keeps increasing when I drag the pill, it
slowly creeps toward the bottom-right."*

`setBounds -> getBounds` is **not an identity** on Windows. Measured here: we
request 167 DIP, Windows stores `167 * 2.5 = 417.5 -> 418` physical, and reads
it back as 168 DIP. One pixel, every time.

That is harmless until something does:

```js
win.setBounds({ ...win.getBounds(), x, y });   // WRONG
```

`_dragTick` runs at 125Hz, so one drag across the screen applied that error
several hundred times. Top-left is pinned by `x`/`y`, so the window inflated
toward the bottom-right and the glass grew a little more with every drag.

Fixed structurally: `manager.js` now contains **exactly one** `setBounds` call,
inside `_place(win, x, y, w, h)`, which states all four values explicitly from
our own state and compares against the last *requested* bounds rather than the
readback. `npm run check` enforces both invariants.

Verified: pill held 168x40 across four full-screen drags and a 48s session.
Panel width previously climbed 640 -> 658 within seconds; now stable.

### 8.5 Missing SWP_FRAMECHANGED after an ex-style change

`excludeFromAltTab()` changed `WS_EX_TOOLWINDOW` via `SetWindowLongPtr` without
the `SetWindowPos(..., SWP_FRAMECHANGED)` that MSDN requires. The window kept
stale cached frame metrics, which contributed to the round-trip error in 8.4.

### 8.6 DWM ignores the window region (the "square glass" bug)

Reported symptom: *"the pill is contained in a square glass background, even the
chat window."*

`SetWindowCompositionAttribute` paints its backdrop across the **entire window
rectangle** and `SetWindowRgn` has no authority over it. The region does clip the
window's own content correctly -- verified by disabling the accent, at which
point the pill and panel render as exact rounded shapes -- but DWM's backdrop
layer is composited outside that clip. Result: a square glass slab behind a
rounded pill.

There is no API that yields an arbitrary rounded backdrop on a layered window:

| Approach | Why it does not work |
|---|---|
| `SetWindowRgn` + accent | Region does not clip the DWM backdrop (measured) |
| `DWMWA_SYSTEMBACKDROP_TYPE` | Requires a non-layered window; same conflict that rules out Electron's `backgroundMaterial` |
| `DwmEnableBlurBehindWindow` + `hRgnBlur` | Designed for exactly this, but stopped blurring after Win7 |
| `DWMWA_WINDOW_CORNER_PREFERENCE` | Works, but a fixed ~8px radius — not a pill |

So shape and real desktop blur are mutually exclusive, and `ui.glass` is an
honest either/or rather than a quality slider:

- **`shaped`** (default) — exact pill and rounded panel via region, CSS-only
  glass, no desktop blur. The silhouette is the identity of the thing, so it
  wins by default.
- **`acrylic`** / **`blur`** — real DWM backdrop, corners handed to DWM (~8px).
  The renderer adds `html.system-corners` so the CSS radius matches the frame.
- **`off`** — shaped, backdrop fully disabled.

### 8.7 Glass mode lost to a startup race

`broadcastGlass()` fires from `ready-to-show`, which can land *before* the
renderer registers its `nimbus.on('glass:changed')` listener. The document then
never received the class that supplies its whole background, and the panel
rendered almost fully transparent.

Fixed by returning the current mode from the `native:status` invoke that both
renderers already await during boot: pull the state, do not rely on catching a
broadcast. Push is still wired for later changes.

---

## 9. Latency: the real numbers

Measured on the target machine (Strix Halo / Ryzen AI MAX+ 395, 128GB unified,
Lemonade serving an NPU). Every number below came from running it, not from
model size or vendor claims.

### 9.1 Stage costs

| stage | cold | warm |
|---|---|---|
| VAD hangover (tunable) | 550ms | 550ms |
| STT — server Whisper-Large-v3, 2s audio | 2.5–5.6s | 2.5–5.6s (no warm benefit) |
| Speaker verification — CAM++ in-process | — | **12–44ms** |
| LLM first token — `qwen3.5-2b-FLM` | 7487ms | **622ms** |
| LLM first token — `academiccloud.deepseek-v4-flash` (cloud) | 2746ms | 2746ms |

### 9.2 Local models are not slow, they are cold

```
qwen3.5-2b-FLM, consecutive:     alternating two models:      after 20s idle:
  call 1   7487ms   cold           2b (warm)   620ms            2b  15146ms
  call 2    647ms                  -> 4b      8323ms  reload
  call 5    622ms   warm           -> 2b      7929ms  reload
```

Three findings, each with a direct design consequence:

1. **Warm local beats cloud on this box.** 622ms versus 2746ms TTFT, and 20.6
   tok/s local versus 78 tok/s cloud — so local wins on latency, cloud on
   throughput. Neither is simply "better".
2. **The server is single-slot.** Switching models costs a full reload. A
   fast/smart pair pointing at *different* models turns every Smart toggle into
   an 8–10s stall, so `WarmthKeeper.switchWarning()` detects and reports it.
3. **It unloads on idle.** An assistant waiting for you to speak is idle by
   definition, so the first utterance after any pause paid ~15s. That was the
   common case, not an edge case.

`src/warmth.js` fixes (3) with a 1-token completion on a 12s interval — inside
the measured ~20s unload window. A `/models` GET does not work: it never touches
the model, so it does not reset the server's idle timer.

### 9.3 STT and chat do not evict each other

Worth confirming rather than assuming, because on a single-slot server the
alternative would have been fatal — every voice turn paying two reloads.
Measured: chat warm 615ms → transcribe → chat 622ms. They hold separate slots.

### 9.4 Where the remaining time goes

With keep-warm active the budget is roughly:

```
550ms hangover + ~3000ms STT + 20ms verify + 622ms TTFT  ~=  4.2s
```

STT now dominates, and it is the one stage that gains nothing from warming.
Whisper-Large-v3 is simply too large for conversational turns. Two routes, both
open:

- **A smaller checkpoint** (base / small / distil-large-v3): typically 5–15x
  faster for a modest accuracy cost.
- **Streaming ASR in-process** (sherpa-onnx Zipformer, already a dependency for
  speaker verification). Streaming transcribes *during* speech, so the cost
  after speech-ends approaches zero rather than being reduced. This is the
  architecturally correct answer for a voice assistant and would put the
  budget near **1.2s**.

---

## 10. Capture privacy: how deep it actually goes

### 10.1 The ceiling

`SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE)` is the deepest
mechanism available to a user-mode process. It is enforced by DWM at
composition time, so it covers every capture route that goes through the
compositor:

| capture path | excluded? |
|---|---|
| Windows.Graphics.Capture (Snipping Tool, Game Bar, modern share) | yes |
| DXGI Desktop Duplication (OBS, most recorders) | yes |
| GDI `BitBlt` / `Graphics.CopyFromScreen` | **yes — measured** |
| Phone camera, capture card, HDMI splitter, KVM | no, and never will be |
| Kernel-mode / display filter driver | no |

The GDI row was verified rather than assumed: a full-desktop
`CopyFromScreen` was taken with the pill protected and visible on screen, and
the pill's region came back showing only the window behind it.

Going below this means a display filter driver — EV-signed, WHQL-attested,
kernel mode, and behaviourally indistinguishable from anti-cheat or malware.
Not a reasonable dependency for a personal assistant, and it still would not
stop a camera pointed at the monitor.

### 10.2 What was actually wrong (it was not the flag)

The flag worked. It was on the wrong window. With stealth enabled, a readback
of `GetWindowDisplayAffinity` across every HWND the process owns showed:

```
640x320  affinity=NONE (capturable)   <- THE PANEL
167x40   affinity=EXCLUDEFROMCAPTURE  <- the pill
```

The pill was hidden and the panel — the window containing the entire
conversation — was fully capturable, while the app reported itself protected.
Whether a screenshot caught anything depended on whether the chat happened to
be open, which is exactly the reported "about 50/50".

Cause: protection was a one-shot `setContentProtection(true)` at construction.
Affinity set on a window that has never been shown does not reliably persist,
and the panel is created with `show: false`.

### 10.3 The fix: apply everywhere, and verify

Three changes, in `native/win32.js` and `windows/manager.js`:

1. **Call `SetWindowDisplayAffinity` directly** instead of Electron's
   `setContentProtection`, because Electron's wrapper gives no way to confirm
   the result.
2. **Read it back.** `getCaptureProtection()` returns the OS's own answer, and
   `stealthStatus().verified` is true only when *every* window reports
   `excluded`. A partial result must never read as success.
3. **Re-assert on every show**, not once at construction.

The settings panel now reports the measured state — "Verified hidden from
capture" or "NOT fully protected" with a per-window breakdown — so the claim
is something the OS confirmed, not something the app requested. Toggling is
also live now; affinity is just a syscall on a live HWND.

### 10.4 Genuinely deeper options, not yet built

All of these are "do not be there" rather than "be invisible", which is
strictly stronger because it does not depend on any capture API cooperating:

- **Hide on capture triggers.** Low-level hook on `PrintScreen` and
  `Win+Shift+S`, hide both windows for a few hundred ms. Immune to every
  capture method, including ones that ignore display affinity.
- **Hide while a capture app is running.** Watch for OBS, Teams, Zoom, Discord
  screen-share and collapse automatically.
- **Panic hotkey.** One key that hides everything instantly.

### 10.5 Interaction worth remembering

Stealth still conflicts with `transparent: true` on some Win11 builds — see
8.1. On the machine this was developed against, enabling it once made the
window render nowhere at all. The verified status line makes that state
diagnosable instead of mysterious.

---

## 11. Known gaps

| Area | State |
|---|---|
| Device control / agentic actions | **Not implemented.** Nimbus reads (screen, audio) but cannot act. Needs a Windows UI Automation tool layer plus a tool-calling loop |
| Neural VAD | Energy VAD only; `_classify()` is the swap point for Silero ONNX |
| Always-on KWS | Transcript-matched wake word; latency bounded by STT round trip |
| Streaming ASR | Not wired. Server Whisper dominates the voice-turn budget at ~3s; sherpa-onnx Zipformer would make it near-free |
| Live translation | Mode exists, is wired to the loopback channel and now has a configurable target language (`stt.targetLang`, which it previously read but nothing ever set). Still turn-based off completed utterances, not continuous subtitle-style streaming |
| Hold-to-talk without the native layer | Degrades to a press/press-again latch. There is no key-up event available without koffi, and the settings screen says so rather than mislabelling it |
| Talk chord conflicts | The poll observes key state, it does not claim the chord, so a chord another app owns still fires that app as well. Default is `Control+Alt+Space` for being uncommon and comfortable to hold |
| Region during animation | Cleared for the ~370ms open animation and reinstated on settle, to avoid ~120 GDI syscalls/sec and the HRGN leak a mid-flight `SetWindowRgn` failure would cause |
| Superseded files | Deleted. The pre-split renderer (`renderer/renderer.js`, `index.html`, `styles.css`, `pcm-processor.js`) shipped inside the asar via the `renderer/**` glob despite being unreachable |
| Stealth mode | `ui.stealth` is off by default because it makes the overlay invisible on this hardware (8.1). If you need capture-hiding, enable it and verify the overlay still draws |

---

## 12. Conversation store (`src/db.js`, `src/history.js`)

### 12.1 Why not JSON files

History began as a folder: `index.json` plus one file per session. That is fine
for listing and wrong for retrieving. Searching meant reading and parsing every
session on every keystroke, so search cost grew with history size on a path that
runs while the user types. Two files also had to agree — a crash between writing
a session and writing the index left the list disagreeing with the sessions.

### 12.2 Why SQLite, and why `node:sqlite`

Electron ships `node:sqlite` in its own Node build. Electron 43 has SQLite
3.53.1 with FTS5 and WAL, verified by running the check under
`ELECTRON_RUN_AS_NODE=1` rather than assuming it.

That matters more than the SQL: `better-sqlite3` is the same queries plus a
compiled dependency, an `electron-rebuild` step, an entry in `asarUnpack`, and
an ABI that breaks on the next Electron bump. The built-in has none of those.

WAL is on so the history list can read while a chat turn is being written —
without it, opening history mid-reply blocks on the writer. `synchronous` is
NORMAL rather than FULL: FULL costs an fsync per commit, and the worst case it
buys back is losing the last turn to an OS-level crash.

### 12.3 The Postgres seam

The store is meant to become Postgres once an agent harness needs it shared
across processes. That is a one-file change *only* while nothing else writes a
query, so `scripts/check.js` fails the build if any module other than `db.js`
contains SQL or requires `node:sqlite`. `history.js` owns the shape of a
conversation and the rules about it; `db.js` owns the SQL.

Two things in the schema are not portable, and both are contained:

| SQLite | Postgres |
|---|---|
| `INTEGER` epoch-millis columns | `BIGINT` |
| `INTEGER PRIMARY KEY AUTOINCREMENT` | `BIGSERIAL` |
| `messages_fts` (FTS5) | `tsvector` column + GIN index |
| `MIN()` with bare columns picking the minimum row | `DISTINCT ON` |

Everything else is standard SQL as written.

### 12.4 Full-text search

`messages_fts` is an external-content FTS5 table: it stores terms and a rowid
pointing back at `messages`, so bodies are not duplicated on disk. Three
triggers keep it in step, and because they fire on cascade deletes too, dropping
a session cannot leave orphaned index rows.

Two things about the query were found by testing, not by reading:

- **User text cannot go into `MATCH` raw.** FTS5 reads `-`, `*`, `"` and `NEAR`
  as operators, so searching for `gpt-4` is a syntax error rather than no
  results. Every token is quoted to make it a literal and given a trailing `*`
  so the list filters as you type.
- **`rank` and `snippet()` are only valid in a SELECT that queries the index
  directly.** Putting them under a `GROUP BY` to collapse hits per session gives
  *"unable to use function snippet in the requested context"*. The fix is two
  CTEs — one reading the auxiliary functions into ordinary columns, one
  aggregating those — with `MATERIALIZED` to stop the optimiser folding them
  back together and reintroducing the error.

### 12.5 Writes

`history.save()` is incremental and idempotent: it writes only the messages
added since the last call, and the insert is keyed on `(session_id, seq)` with
`ON CONFLICT DO NOTHING`. Persisting after every turn therefore costs one INSERT,
and saving twice for the same turn — which happens when a request is aborted
after the reply already landed — cannot duplicate a message.

The save is in a `finally`, not on the success path. The user's question is
appended before the request goes out, so a provider error or an aborted reply
used to throw that question away — exactly the conversations you most want to
find again.

Failure is non-fatal throughout. If the database will not open, every function
degrades to a no-op and the app still answers questions; an assistant that
cannot remember beats an assistant that will not start.

### 12.6 Migration

The JSON folder is imported once, into an empty database only, so a later launch
cannot duplicate it. The folder is then renamed to `history.imported` rather than
deleted — if the import got something wrong, the originals are still there.
