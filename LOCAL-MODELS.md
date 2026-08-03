# Choosing the in-the-box model

Nimbus's Simple tier runs a model on the user's own machine, downloaded on
demand, so that an install with no provider and no local server can still answer
something. This is the record of how the three models in `src/local/catalog.js`
were chosen: what was measured, on what, and why the two that lost, lost.

Numbers come from `src/local/engine.js` itself, not from a side path — the
candidates were installed, launched and queried exactly as a user's machine will
do it, on the portable CPU build.

## The machine

AMD Ryzen AI MAX+ 395, 32 logical cores, 32 GB RAM, Windows 11. llama.cpp
`b10223`, CPU build, 8 threads (what the engine picks here: half the logical
cores, capped at 8), context 4096.

Throughput is machine-specific and a minimum-spec laptop will see a fraction of
it. The ordering and the memory figures are the transferable part.

## The checks

Six prompts, each with a mechanical pass condition, covering what this tier is
actually for and nothing it is not:

| check | asks for |
|---|---|
| `tidy` | punctuate a dictated sentence without adding or dropping facts |
| `format` | reply with JSON only, correct values |
| `short` | one-sentence factual answer |
| `nav` | practical answer about using Nimbus, under 160 words |
| `summary` | one-sentence summary that keeps the key term |
| `refuse` | say "I don't know" instead of inventing a share price |

No reasoning task appears here on purpose. If this tier could pass one, the
sprint would have picked the wrong model — the honest claim is navigation, short
answers and transcript tidying, and the checks test that claim.

## Results

| model | quant | file | resident | tok/s | checks | licence |
|---|---|---|---|---|---|---|
| **Qwen2.5 0.5B Instruct** | Q4_K_M | 379 MB | **542 MB** | 125 | **6/6** | Apache-2.0 |
| SmolLM2 360M Instruct | Q8_0 | 369 MB | 590 MB | 134 | 4/6 | Apache-2.0 |
| **Gemma 3 1B IT** | Q4_K_M | 769 MB | 1021 MB | 65 | **6/6** | Gemma Terms |
| Llama 3.2 1B Instruct | Q4_K_M | 770 MB | 1446 MB | 68 | 5/6 | Llama 3.2 Community |
| **Qwen2.5 1.5B Instruct** | Q4_K_M | 940 MB | **1745 MB** | 56 | **6/6** | Apache-2.0 |

Resident is the server's working set with the model loaded at full context,
measured from outside the process. It is roughly double the download for every
candidate, which is why the settings pane shows both numbers: a user who is told
"379 MB" and then loses half a gigabyte of memory has been misled.

These are CPU-build figures, and they are the conservative ones. On an
accelerated build the weights sit in the GPU allocation rather than the process
working set, so the same 1.5B model that measures 1745 MB here measures about
1060 MB on the Vulkan build — on an integrated GPU that memory is still system
RAM, and on a discrete card it genuinely is not. The catalog carries the CPU
number because it is the one that is never an understatement.

Cold start with the file already on disk is about one second for all five, and
first reply lands ~100 ms after that. That is what makes the unload-on-connect
rule affordable: dropping the model when a provider appears costs a second to
undo.

## Why these three

**Qwen2.5 0.5B is the default.** It passed everything, it is the smallest
resident footprint in the field, and at 542 MB it leaves an 8 GB machine alone.
Nothing else at this size passed all six.

**SmolLM2 360M lost on quality, not speed.** It is the fastest thing here by 8%
and it failed the `nav` and `refuse` checks — it answered a question about a
share price it could not know, and gave a Nimbus question a generic answer.
Speed is not the binding constraint at 125 tok/s; being wrong is.

**Llama 3.2 1B lost on a refusal.** Asked to punctuate the dictated sentence
*"so um i was thinking we should probably ship the the release on friday..."* it
replied *"Sorry, I can't assist with planning a release date."* A spurious
refusal on the exact job this tier exists to do is disqualifying, and it wants
40% more memory than Gemma to do it.

**Gemma 3 1B is offered but never auto-selected.** Best quality-per-megabyte in
the field: 6/6 at 1021 MB. It carries Google's use policy rather than a plain
open licence, and a hardware probe result is not consent to a licence, so
`src/hardware.js` will not pick it for anyone. It appears in the Models tab with
its licence named, for a user to choose.

**Qwen2.5 1.5B is the step up.** 6/6, Apache-2.0, and noticeably steadier on
format-following. At 1745 MB it is only offered automatically to machines with
12 GB or more.

## Re-running this

The harness lives outside the repo (it downloads gigabytes and writes a scratch
data directory). It monkey-patches `catalog.MODELS` with the candidate list,
then for each one calls `engine.ensure({ build: 'cpu', modelTier: id })`, hits
`/v1/chat/completions` on the endpoint the engine reports, reads throughput from
llama-server's `timings`, and takes the working set from
`Get-Process llama-server`. The sha256 of each file that produced these numbers
is pinned in the catalog, so a re-run that disagrees is a re-upload, not drift.
