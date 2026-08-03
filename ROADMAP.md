# Roadmap: 1.2.0 to 1.5.0

The goal this plan serves: intelligence that is usable by anyone, whatever hardware
or software they have. Every item below is judged against that first, and against
the machine at the bottom of the range rather than the one it was written on.

Windows is the only target until 1.5.0 ships and the leaning-out after it is done.
macOS, Linux and everything else are 4.0 and later. Nothing in this plan may be
made harder to finish in order to make a later port easier.

## Where 1.2.0 leaves us

- The panel is typed into without ever taking the foreground, so the caret in the
  user's own window survives. `src/native/keytap.js`, released in 1.2.0.
- Transcription runs locally by default, on a whisper.cpp engine Nimbus installs
  and manages itself, with the build and model chosen from a hardware probe.
  `src/whisper/{catalog,engine}.js`, `src/hardware.js`.
- Conversations, history, context compression, digests and providers all work.
- There is no onboarding. `onboarded` is a flag in the store that nothing sets.
- There is no tool calling anywhere in `src/llm.js`. The model cannot reach past
  its own weights.
- `#smart` is a boolean toggle over a `routes` map that already understands
  `fast`, `smart` and `vision` tiers.

## Principles this plan does not trade away

1. Nimbus never takes the foreground and never takes the caret. Anything that
   would is wrong, however good it looks.
2. Nothing leaves the machine without the user having been asked in words they
   read. Audio least of all.
3. Every feature degrades to the minimum-spec path. If it only works with a
   frontier model behind it, it is not finished.
4. Performance claims are measured before and after, on this machine, and the
   numbers go in the commit message.
5. Windows-native behaviour beats a portable abstraction. We are writing a
   Windows app.

---

# 1.3.0 — First run

The release that makes Nimbus explicable to somebody who has never seen it, and
stops it doing anything with audio that they did not ask for.

## Sprint 1: bugs on the floor, consent, defaults, onboarding

Why: `captureSystem` defaults to true, so the first time a user turns listening
on, everything coming out of their speakers is transcribed. That is defensible
only if they were asked. They are not asked, because there is nothing to ask
them with. Three defects sit on the same surfaces and are cleared first.

### Bugs

- The pill's menu stays open when the chat is expanded. Opening the panel is a
  different intent; the menu should close with it.
- With the chat open, the menu opens *behind* the panel and cannot be reached
  without collapsing the panel first. Both windows are topmost at the same
  level, so the later one wins; the pill has to be raised while its menu is out.
- The model is blind unless the user picks "My screen". Vision is a capability,
  not a mode: when the routed model is known to accept images, a typed question
  carries the screen by default, with a setting to turn that off and the
  known-blind case still falling through to the vision route. This reverses a
  deliberate earlier decision, so the reasons it was made — latency, upload cost,
  rejected requests on text-only models — are handled rather than ignored: only a
  model *proven* to see triggers it, and unknown stays opt-in.

### Consent and defaults

- Flip `audio.captureSystem` to default false and gate it behind an explicit
  choice. `listenOnLaunch` is already false and stays that way.
- Add a migration in `src/store.js` that does not silently turn off system audio
  for people who deliberately enabled it, but does re-ask anyone who never chose.

### Onboarding, in two stages

Stage one is setup, and it runs before the tutorial because most people expect
an app to work out of the box rather than to be configured into working:

- A list of what Nimbus wants to install, ticked by default, each sized against
  the hardware probe: the transcription model (`src/whisper`, chosen by
  `src/hardware.js`), and — once Sprint 3 lands — the Simple-tier model chosen
  the same way. Everything installs under the user's own profile, so no
  elevation is needed; if a path ever does need it, ask before touching it.
- The screen waits, visibly, while they download and install, with progress and
  a working cancel. Nothing else in the app is blocked by it.
- Unticking is allowed and explained: Nimbus still runs, with that piece missing.

Stage two is the tutorial: what Nimbus is, what it listens to and when (the
system-audio choice is made here), where its intelligence comes from, and the
shortcuts it will use. Every step skippable, and a Skip All for people who do not
want it. Set `onboarded` at the end, and add a "run this again" entry in
settings.

Both stages are panel states, not a third window. The window manager owns two
windows and should not grow another. Both must be completable on a machine with
no provider configured and no network — a failed download is a message, not a
dead end.

Done when: a fresh profile reaches a usable app without reading any
documentation; system audio is never captured until a human said yes; the three
bugs above are gone; and `onboarded` survives a restart.

## Sprint 2: the tier indicator, the chip, the glass, the motion

Why: `#smart` is a single-purpose toggle that says nothing about what it is
toggling between. The provider and model names take a lot of room to tell most
users nothing they can act on.

Work:

- Replace the toggle with a three-state indicator: **Simple**, **General**,
  **Smart**. Click cycles; the state is readable at a glance without clicking.
- Tiers unlock as they are earned. Simple is always present (1.4.0 gives it a
  model of its own; until then it is the smallest configured route). General
  appears once any provider or local endpoint is connected. Smart appears once a
  model capable of the harder work is connected. A locked tier is visible but
  explains what would unlock it, rather than being hidden and mysterious.
- Map the three tiers onto the existing `routes` map. No second routing concept.
- Demote the provider and model names to a small light indicator, off by default,
  shown under an advanced setting that lives with the model indicator section.
- Glass: the current `ui.glass: 'shaped'` acrylic keeps text legible over a busy
  desktop only sometimes. Add a distortion and contrast layer under text runs
  specifically, so readability does not depend on what is behind the window.
  Measured with a contrast check against several backgrounds, not by eye.
- Motion pass over the whole app: one spring, one set of durations, one easing
  vocabulary, in `src/spring.js` and the two stylesheets. Everything that moves
  either uses it or has a comment saying why not. Nothing bounces. Nothing
  announces itself. `ui.reduceMotion` genuinely stops all of it.

Done when: the indicator explains the app's capability without a manual; the
model chip is off by default; text is legible over a white document, a photo and
a video; and every animation in the app comes from one place.

---

# 1.4.0 — A model in the box, and a tool in its hand

The release where Nimbus is useful on a machine that has nothing else, and where
the model stops being limited to what it memorised.

## Sprint 3: the Simple tier gets its own model

Why: the promise is intelligence regardless of hardware. Today a user with no
provider and no local server has an app that cannot answer anything.

Work:

- Mirror the whisper pattern exactly: a catalog and an engine, chosen by
  `src/hardware.js`. This is a solved problem in this codebase; do not invent a
  second way of doing it.
- Target: a 0.5B-1B instruct model, quantised, that fits and runs on CPU inside
  8GB of system memory with the rest of the app running. Candidate shortlist and
  a measured comparison go in the sprint, not in this document.
- Download on demand with a clear size and a cancel, never as part of install.
- Unload automatically when a real provider or local endpoint is connected, and
  reload if it goes away. The user should never have both resident.
- Be honest in the UI about what this tier is for: navigating Nimbus, short
  answers, tidying transcripts. It is not a reasoning model and must not be
  presented as one.

Done when: a fresh install with no network beyond the model download can hold a
conversation; connecting a provider frees the memory within seconds; and the
minimum-spec machine stays responsive while it runs.

## Sprint 4: the web, and the first piece of the harness

Why: a model that cannot look anything up is wrong about the present. This is
also the seam every later harness component plugs into, so the seam matters more
than the first tool through it.

Work:

- Build tool calling in `src/llm.js` properly the first time: a registry, a
  schema per tool, a result envelope, a per-tool timeout, and a transcript the
  user can open and read. Providers that cannot do tool calls get a documented
  fallback path.
- First tool: retrieval. Search, fetch, extract to text, summarise into context.
  Pluggable backend, because search APIs change and some need keys.
- Security is part of the sprint, not a follow-up. Retrieved text is untrusted
  input: it is fenced before it reaches the model, never executed, never
  interpreted as instructions. Fetching is blocked against loopback, link-local
  and private ranges. Redirects are re-checked. Credentials are never attached.
  Size and time are capped.
- Privacy is explicit: a query leaving the machine is a disclosure. The user is
  told which backend, asked once, and can turn it off permanently. When the tier
  is Simple and local, nothing goes out unless they said so.
- Visible in the UI whenever it happened, with the sources listed and clickable.

Done when: a question about something after the model's cutoff is answered with
sources; every fetch respects the address rules under test; and the tool
registry can take a second tool without being reshaped.

## Sprint 5: prompts and routing that fit every size of model

Why: one system prompt written for a strong model makes a 0.5B model incoherent,
and one written for a small model wastes a frontier model. Both are in scope now.

Work:

- Restructure `src/prompts.js` around a core that every model gets and layers
  that are added only when the model can use them: tool protocol, long-context
  behaviour, multi-step reasoning, structured output.
- Make routing a decision with inputs rather than a switch: task shape, context
  size, whether tools are needed, tier availability, and measured latency of
  what is connected.
- Build a small evaluation set from real Nimbus tasks: transcript questions,
  screen questions, digests, retrieval questions, short chat. Run it against a
  0.5B local model, a mid model and a frontier model. Prompt changes are accepted
  or rejected on those results.
- Degrade honestly: when the connected model cannot do what was asked, say so and
  offer the tier that can, rather than producing a confident wrong answer.

Done when: the same task produces a sensible answer at all three tiers, differing
in depth rather than in correctness, and routing choices can be explained from a
log line.

---

# 1.5.0 — Native and lean

The release that makes Nimbus feel like part of Windows rather than a web app in
a frameless window.

## Sprint 6: speed, responsiveness, resources

Work:

- Establish the budget first and write it down: idle CPU, resident memory with
  and without the local model, panel open latency, first-token latency, frame
  time during animation, and the cost of the input hooks while typing.
- Measure the current numbers against it and fix what misses, in order of what
  the user actually feels: panel open, first token, typing latency, then idle.
- Startup: nothing on the launch path that is not needed to draw the pill.
  Everything else is deferred, including the whisper engine and the store's
  heavier reads.
- Idle: audit every timer and poll in the app. The 60ms foreground poll only
  exists while typing and should stay that way; the others get the same scrutiny.
- Renderer: the panel does its own layout maths in several places. One layout
  path, no synchronous reads inside animation frames.

Done when: every number in the budget is met and the before and after are in the
commit message.

## Sprint 7: native behaviour and hardening

Work:

- Behave like a system utility: correct DPI behaviour on every monitor and on
  change; sensible multi-monitor placement; respect for Windows accent, contrast
  and reduced-motion settings; tray behaviour that matches what Windows users
  expect; correct behaviour across lock, sleep, resume and fast user switching.
- Installer and update path that does not surprise anyone: the single-instance
  behaviour must never leave a user staring at a window that quietly refused to
  start.
- The stealth and capture-protection paths get a test pass of their own.
- Full sweep of every suite in the scratchpad against real OS state, not
  synthesized events, as the release gate.

Done when: Nimbus survives a day of ordinary Windows life — docking, undocking,
sleeping, locking, display changes — without a restart or a visible seam.

---

# After 1.5.0

- **2.0** — the fuller harness: more tools, memory, multi-step work with a
  transcript the user can read and interrupt, and the permission model that has
  to exist before any of that is on by default.
- **3.0** — lean out again. Everything 2.0 added, made smaller and faster, and
  whatever the tiny-model tier learned from a year of use folded back in.
- **4.0 and later** — other platforms, starting with the one that shares the most
  with what we have.

# Open decisions

These block work in the sprint named, and are the user's call.

1. **Simple-tier model** (Sprint 3). Which family, and is a download of that size
   acceptable on first run, or does the Simple tier stay empty until asked for?
2. **Search backend** (Sprint 4). A keyless default that is fragile, or a
   key-based service that is reliable but asks the user for an account?
3. **Retrieval default** (Sprint 4). Off until switched on, or on for the
   General and Smart tiers with a clear indicator?
4. **Tier naming** (Sprint 2). Simple, General and Smart as written here, or
   something that reads less like a pricing table.
5. **System-audio migration** (Sprint 1). Re-ask everybody, or only profiles that
   never made an explicit choice?
