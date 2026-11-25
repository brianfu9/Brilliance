# Settings reference

Every setting Brilliance reads, in one place, for a person or an agent: the YAML profile's keys, the
launcher's and the tools' command lines, the scripts' parameters, and every environment variable the
code reads. Each entry gives what it means, its default, the values it takes, who should touch it, and
the source line that reads it. `win/tools/docs_check.py` fails when this page and the code disagree, in
either direction. The package carries this page as `REFERENCE.md`; its source lines (`core/...`,
`win/...`) name files in the source repository at the same release. The
[Windows known-issue table](https://github.com/adamczhang/Brilliance/blob/main/win/SUPPORT.md#known-issues) (`SUPPORT.md` in the package) covers
support limits and qualification gaps.

## Most people only need these

Start a server with `serve.ps1` and one of the shipped profiles. These are the settings a first user
changes; everything else has a tested default.

| Setting | Where | What it does |
|---|---|---|
| `<profile>` | `serve.ps1` | which model and settings: a name in `profiles\` (see [Supported models](https://github.com/adamczhang/Brilliance/blob/main/README.md#supported-models)) |
| `-Bus` | `serve.ps1` | the cards, by PCI bus (Device Manager, Location); one card needs none |
| `-Fetch` | `serve.ps1` | download the profile's model first (resumable, checked) |
| `-Listen 0.0.0.0`, `-Port`, `-ApiKey` | `serve.ps1` | serve the local network; `-ApiKey off` or `env:NAME` |
| `-Background`, `-Log` | `serve.ps1` | run in a console of its own; stop it with `tools\stop-server.ps1 -ProcessId N` |
| `-Cpu` | `serve.ps1` | serve on the CPU, no GPU touched |
| `-Check`, `-WhatIf` | `serve.ps1` | validate, or show what a start would do, without serving |
| `BRILLIANCE_HF_CACHE` | environment | where models are downloaded to |
| `max-model-len` | profile | the context length (0: the model's own) |
| `max-num-seqs` | profile | how many requests run at once |
| `gpu-headroom-mib` | profile | VRAM left free on each card |
| `temp`, `top-p`, `top-k` | profile | sampling defaults for requests that send none |

## Reading this page

**Who** says who should change a setting:

- **user**: anyone serving a model; safe to change.
- **operator**: someone tuning a profile or running a server for others; read the meaning first.
- **developer**: diagnostics, tests, builds and measurements. It slows the server, writes large
  files, injects faults or changes tested behaviour. Never on a server people use.
- **launcher**, **build**: set by `serve.ps1`, or by `win\env.ps1` from the toolchain manifest. Set them
  yourself only where the entry says so.
- **system**, **internal**: set by Windows or by the scripts themselves. Never set them.

**Read at** is the source line that reads the setting (for a YAML key, where the option is parsed).

**How the layers combine.** radiance reads one YAML file (`--config`). `serve.ps1` never rewrites it:
its `-Listen`, `-Port`, `-ApiKey`, `-Cpu`, `-Model` and `-ModelName` reach radiance as the
`BRILLIANCE_SERVER_*` variables and `BRILLIANCE_MODEL_PATH` and `BRILLIANCE_MODEL_NAME`, which radiance applies over the file at the
start and at every reload, and its startup report names each value's source. A profile's
`# brilliance-env:` lines and `serve.ps1 -Env` set other variables for the server process only. Under
`memory:` a key applies to every model; a model that sets `gpu-memory-mib` or `gpu-headroom-mib` itself
replaces the pair. `defaults:` is merged under every model. A request's own sampling fields win over the
profile's defaults.

**Safety, in short:**

- Never raise `BRILLIANCE_PIN_LIMIT_GIB` or any other memory or safety guard above what the server
  computes, and never set it to test where the limit is. That needs the explicit approval of the
  machine's owner. Pinned memory past the Windows budget pages, and can stall or hang the machine.
- Stop a server with Ctrl-Break (`tools\stop-server.ps1`), never by killing it: a killed GPU process can
  hold the card and host memory until a reboot.
- `0.0.0.0` opens the server to the network: pair it with a firewall rule for the local network and a
  key unless the network is trusted.
- The **developer** settings are for diagnosis. Fault injection (`BRILLIANCE_AR_INJECT`) can stop a server.

## Contents

- [The launcher and the server scripts](#the-launcher-and-the-server-scripts)
- [The YAML profile](#the-yaml-profile)
- [Environment variables](#environment-variables)
- [Tools](#tools)
- [Building from source](#building-from-source)

## The launcher and the server scripts

### `serve.ps1`: start a profile

`.\serve.ps1 <profile> [options]`, from the package's root (`win\serve.ps1` in the source). Its `-Listen`, `-Port`, `-ApiKey`, `-Cpu` and `-Model` reach radiance as the `BRILLIANCE_SERVER_*` and `BRILLIANCE_MODEL_PATH` variables below; everything else is the profile's.

<!-- settings: ps:serve.ps1 -->

| Setting | Meaning | Default | Values | Who | Read at |
|---|---|---|---|---|---|
| `-Profile` | the profile: a name in `profiles\` (`qwen27-preview`) or a path to a YAML file. The first, positional argument. | required | name or path | user | `win/serve.ps1:108` |
| `-Bus` | the cards, by PCI bus as Windows shows it (`3`, `0x20`, or `0000:20:00.0`). Translated to HIP indices by asking the HIP runtime. | every discrete card (the integrated GPU hidden) | comma-separated buses | user | `win/serve.ps1:112` |
| `-Device` | the cards by HIP index, as they are. **Safety:** HIP's numbering changes across boots; prefer `-Bus`. | as `-Bus` | comma-separated indices | operator | `win/serve.ps1:113` |
| `-Listen` | the listen address (`BRILLIANCE_SERVER_HOST`). **Safety:** `0.0.0.0` opens the server to the network; pair it with a firewall rule and a key unless the network is trusted. | the profile's address or the engine default (`127.0.0.1`) | IP address | user | `win/serve.ps1:114` |
| `-Port` | the listen port (`BRILLIANCE_SERVER_PORT`) | the profile's (8000) | 1-65535 | user | `win/serve.ps1:115` |
| `-ApiKey` | the key policy (`BRILLIANCE_SERVER_API_KEY`): `off`, or `env:NAME` to read the key from variable NAME | the profile's | `off` \| `env:NAME` | user | `win/serve.ps1:116` |
| `-Check` | validate the profile (`radiance --check`), print the resolved listener and its sources, and exit | off | switch | user | `win/serve.ps1:117` |
| `-WhatIf` | print what a start (or `-Install`, `-Uninstall`, `-Fetch`) would do, and do nothing | off | switch | user | `win/serve.ps1:127` |
| `-Background` | start in a hidden console of its own; stop it with `tools\stop-server.ps1` | off (this console) | switch | user | `win/serve.ps1:118` |
| `-Log` | with `-Background` or `-Install`: the log file | `radiance-<profile>.log` in this folder (`-Background`); `<Name>.log` beside the service's YAML (`-Install`) | path | user | `win/serve.ps1:119` |
| `-Exe` | the `radiance.exe` to run | `bin\` beside the script, else `build-win\hip\bin` | path | developer | `win/serve.ps1:120` |
| `-Env` | variables for the server, `NAME=VALUE[,NAME=VALUE]`, over the profile's `# brilliance-env:` lines. Only `GPU_*`, `HIP_*`, `AMD_*`, `BRILLIANCE_*`, `RADIANCE_*`; not `HIP_VISIBLE_DEVICES`, not a name that looks like a secret, no comma in a value. | none | NAME=VALUE list | operator | `win/serve.ps1:123` |
| `-Cpu` | serve on the CPU: `BRILLIANCE_DEVICE=host`, the host kernels, no drafting. Not with `-Bus` or `-Device`. | off | switch | user | `win/serve.ps1:133` |
| `-Model` | serve this file or checkpoint folder in place of the profile's `model:` (`BRILLIANCE_MODEL_PATH`) | the profile's | path | user | `win/serve.ps1:135` |
| `-ModelName` | with several models in the profile: the one `-Model` or `-Fetch` replaces | the profile's only model | a name under `models:` | user | `win/serve.ps1:136` |
| `-Fetch` | fetch the file the profile's `# brilliance-fetch:` line names (resumable, SHA-256 checked), then serve it | off | switch | user | `win/serve.ps1:137` |
| `-ModelDir` | with `-Fetch`: the store to fetch into, `<dir>\<owner>\<repo>` | `BRILLIANCE_HF_CACHE`, else `%LOCALAPPDATA%\radiance\hf` | folder | user | `win/serve.ps1:138` |
| `-Install` | register the profile as a Windows service (elevated): copies it to `%ProgramData%\Brilliance\<Name>\`. **Safety:** a profile holding `api-key:` is refused; the key goes in a file only SYSTEM and Administrators read. | off | switch | operator | `win/serve.ps1:125` |
| `-Uninstall` | stop the service (its drain) and remove it (elevated); the YAML and logs stay | off | switch | operator | `win/serve.ps1:126` |
| `-Name` | the service's name | `Brilliance-<profile>` | name without `/` or `\` | operator | `win/serve.ps1:128` |
| `-Manual` | the service starts on demand, not delayed-automatic at boot | off | switch | operator | `win/serve.ps1:129` |
| `-NoRestart` | no recovery action on a service failure | off (restart once after 2 minutes, not again within a day) | switch | operator | `win/serve.ps1:130` |
| `-StopTimeoutS` | seconds a service stop (the drain) may take before it is reported; never ended by force | 180 | 1-86400 | operator | `win/serve.ps1:131` |
| `-WaitS` | with `-Uninstall`: seconds to wait for the drain before deleting | 300 | whole seconds | operator | `win/serve.ps1:132` |

### Profile comment lines

radiance skips these as comments; `serve.ps1` reads them from the profile.

<!-- settings: profile-comment -->

| Setting | Meaning | Default | Values | Who | Read at |
|---|---|---|---|---|---|
| `# brilliance-env:` | variables `serve.ps1` sets for the server: `NAME=VALUE`, several separated by commas, as many lines as needed, no trailing comment. The same names `-Env` takes; `-Env` overrides. | none | NAME=VALUE list | operator | `win/serve.ps1:743` |
| `# brilliance-fetch:` | what `serve.ps1 -Fetch` fetches: `<owner/repo> <revision> [<file>]`; one line a profile | none | repo, revision, optional file | operator | `win/serve.ps1:752` |

### `tools\serve-bg.ps1`: start radiance in a console of its own

For tests and measurements: a hidden console, so `stop-server.ps1` can stop it with Ctrl-Break. Prints the server's process id.

<!-- settings: ps:serve-bg.ps1 -->

| Setting | Meaning | Default | Values | Who | Read at |
|---|---|---|---|---|---|
| `-Bin` | the folder holding `radiance.exe` | required | folder | developer | `win/tools/serve-bg.ps1:16` |
| `-Config` | the YAML file | required | path | developer | `win/tools/serve-bg.ps1:17` |
| `-Log` | the log file; it ends with `radiance exit status N` | required | path | developer | `win/tools/serve-bg.ps1:18` |
| `-Devices` | sets `HIP_VISIBLE_DEVICES` (HIP indices) | the caller's | indices | developer | `win/tools/serve-bg.ps1:19` |
| `-RadianceHome` | sets `RADIANCE_HOME` | beside the executable | folder | developer | `win/tools/serve-bg.ps1:20` |
| `-Append` | add to the log rather than start it afresh | off | switch | developer | `win/tools/serve-bg.ps1:22` |

### `tools\stop-server.ps1`: stop a server with Ctrl-Break

The engine drains, frees its pools and exits. Nothing is force-killed.

<!-- settings: ps:stop-server.ps1 -->

| Setting | Meaning | Default | Values | Who | Read at |
|---|---|---|---|---|---|
| `-ProcessId` | the server's process id | required | process id | operator | `win/tools/stop-server.ps1:20` |
| `-WaitS` | seconds to wait for the exit; a server still running then is reported (exit 3) and left alone. **Safety:** never follow it with a forced kill of a GPU process. | 120 | whole seconds | operator | `win/tools/stop-server.ps1:20` |

### `tools\reload-server.ps1`: reread the YAML

What `kill -HUP` does on Linux: the running server rereads its `--config` (as `POST /admin/reload` does).

<!-- settings: ps:reload-server.ps1 -->

| Setting | Meaning | Default | Values | Who | Read at |
|---|---|---|---|---|---|
| `-ProcessId` | the server's process id | required | process id | operator | `win/tools/reload-server.ps1:23` |

### `libexec\brilliance\hfget.ps1`: fetch a Hugging Face repo

`hfget.ps1 <repo-id> [dest-dir] [revision] [file] [-Plan]`. radiance runs it for a repo-id `model:`, and `serve.ps1 -Fetch` runs it. Reads `HF_TOKEN`, `HF_ENDPOINT` and `HFGET_JOBS`.

<!-- settings: ps:hfget.ps1 -->

| Setting | Meaning | Default | Values | Who | Read at |
|---|---|---|---|---|---|
| `-Repo` | the repo id, `owner/name` (first positional) | required | owner/name | user | `win/libexec/hfget.ps1:74` |
| `-Dest` | the destination folder (second positional) | `<store>\<owner>\<repo>` (see `BRILLIANCE_HF_CACHE`) | folder | user | `win/libexec/hfget.ps1:75` |
| `-Rev` | the revision (third positional) | main | branch, tag or commit | user | `win/libexec/hfget.ps1:76` |
| `-Only` | one file of the repo (fourth positional); needed when the repo holds several `.rad` containers | the whole repo | file name | user | `win/libexec/hfget.ps1:77` |
| `-Plan` | print the plan (commit, files, sizes) and transfer nothing | off | switch | user | `win/libexec/hfget.ps1:78` |

## The YAML profile

A profile (`profiles\<name>.yaml`) is radiance's whole configuration. `radiance --help` prints these keys
by level, and [docs/GUIDE.md](https://github.com/adamczhang/Brilliance/blob/main/docs/GUIDE.md#411-every-key) and
[docs/MULTIMODEL.md](https://github.com/adamczhang/Brilliance/blob/main/docs/MULTIMODEL.md) explain them at length. A key belongs under its **Level**:
`server:` for the process, `memory:` for every model, and every other option to a model's entry under
`models:` (or to `defaults:`, merged under every model). A switch is set with `true`. Each option has a
command-line spelling, `--KEY`, which radiance refuses on its command line, printing the YAML it means.
The YAML spells four flags differently: the entry's name under `models:` is the served model name, and
`server.log: debug` or `trace` replaces `-v` and `-vv`.

### The file's levels and fleet keys

Read by `core/fleet/config.cpp`; durations are `250ms`, `30s`, `30m` or `2h`. A top-level key starting `x-` is ignored (a place for YAML anchors).

<!-- settings: yaml -->

| Key | Meaning | Default | Values | Who | Read at |
|---|---|---|---|---|---|
| `server` | the process's level: listening, keys, HTTP limits, `log:`, and the keys marked `server:` below |  | map | user | `core/fleet/config.cpp:59` |
| `log` | under `server:`: the log level | info | `info` \| `debug` \| `trace` | operator | `core/fleet/config.cpp:356` |
| `cards` | top level: the cards any model may use; on a model: the cards it may be placed on (ordinals as radiance sees them, after `serve.ps1 -Bus`) | all | `all` \| `[N, ...]`, 0-63 | operator | `core/fleet/config.cpp:59` |
| `memory` | the memory level: `host-mib`, `disk-tier`, `card-headroom-mib` and the per-card pair, for every model |  | map | operator | `core/fleet/config.cpp:59` |
| `host-mib` | under `memory:`: pinned host RAM the whole process may hold. **Safety:** pinned memory comes out of the Windows pin budget. | unset (each model's own) | MiB | operator | `core/fleet/config.cpp:517` |
| `disk-tier` | under `memory:`: the folder for the prefix cache's disk tier and park files | none | folder | operator | `core/fleet/config.cpp:521` |
| `card-headroom-mib` | under `memory:`: VRAM left free per card, by card ordinal | none | map, as `{0: 4096}` | operator | `core/fleet/config.cpp:525` |
| `scheduler` | the fleet scheduler's level |  | map | operator | `core/fleet/config.cpp:59` |
| `load-timeout` | under `scheduler:`: how long a request waits for its model to load | 120s | duration | operator | `core/fleet/config.cpp:560` |
| `drain-timeout` | under `scheduler:`: how long a model being evicted may finish its requests | 30s | duration | operator | `core/fleet/config.cpp:561` |
| `swap-hold` | under `scheduler:`: while another model waits, a busy model keeps the card until it has no work, up to this duration; 0 is off | 0 (off) | duration | operator | `core/fleet/config.cpp:562` |
| `keepalive` | under `scheduler:`: the SSE comment interval while a request waits | 10s | duration | operator | `core/fleet/config.cpp:563` |
| `stuck-exit` | under `scheduler:`: a device stuck this long ends the process; 0 never | 60s | duration | operator | `core/fleet/config.cpp:564` |
| `warm-up` | under `scheduler:`: fill free VRAM, then host RAM, with models at start | true | true \| false | operator | `core/fleet/config.cpp:565` |
| `defaults` | any model key, merged under every model (not `aliases` or `cards`) |  | map | operator | `core/fleet/config.cpp:59` |
| `models` | the models, by name: the name is the model id requests use | required | map of name to model keys | user | `core/fleet/config.cpp:59` |
| `aliases` | on a model: more ids for it | none | list of names | user | `core/fleet/config.cpp:57` |
| `priority` | on a model: higher keeps VRAM and takes flex from lower | 0 | whole number | operator | `core/fleet/config.cpp:57` |
| `pin` | on a model: never leaves VRAM | false | true \| false | operator | `core/fleet/config.cpp:57` |
| `ttl` | on a model: park after this long without requests | never | duration | operator | `core/fleet/config.cpp:57` |
| `flex` | on a model: how far its KV and experts may shrink and grow for others: `{kv: {...}, experts: {...}}` | none | map | operator | `core/fleet/config.cpp:57` |
| `kv` | under `flex:`: the KV range: `min-tokens`, `max-tokens`, `weight` |  | map | operator | `core/fleet/config.cpp:680` |
| `min-tokens` | under `flex: kv:`: the fewest KV tokens |  | whole number | operator | `core/fleet/config.cpp:686` |
| `max-tokens` | under `flex: kv:`: the most KV tokens |  | whole number | operator | `core/fleet/config.cpp:687` |
| `weight` | under `flex: kv:`: its share when KV is divided |  | number | operator | `core/fleet/config.cpp:688` |
| `experts` | under `flex:`: the expert range: `min-mib`, `max-mib` |  | map | operator | `core/fleet/config.cpp:680` |
| `min-mib` | under `flex: experts:`: the least expert VRAM |  | MiB | operator | `core/fleet/config.cpp:692` |
| `max-mib` | under `flex: experts:`: the most expert VRAM |  | MiB | operator | `core/fleet/config.cpp:693` |
| `park` | on a model: how it parks: `{vram: ..., ram: ..., restore: ...}` |  | map | operator | `core/fleet/config.cpp:57` |
| `vram` | under `park:`: what stays on the card | none | `none` \| `statics` \| MiB | operator | `core/fleet/config.cpp:715` |
| `ram` | under `park:`: whether a parked model's weights go to host RAM | allowed | `required` \| `allowed` \| `never` | operator | `core/fleet/config.cpp:715` |
| `restore` | under `park:`: how it comes back | auto | `auto` \| `full` \| `live` | operator | `core/fleet/config.cpp:715` |
| `groups` | named groups of models: `together:` (loaded and parked together) or `exclusive:` (never resident at once) | none | map | operator | `core/fleet/config.cpp:59` |
| `together` | under a group: models loaded and parked together |  | list of names | operator | `core/fleet/config.cpp:603` |
| `exclusive` | under a group: models never resident at the same time |  | list of names | operator | `core/fleet/config.cpp:604` |

### Model, files and chat template

<!-- settings: yaml -->

| Key | Level | Meaning | Default | Values | Who | Read at |
|---|---|---|---|---|---|---|
| `model` | a model (or `defaults:`) | the .rad container, a checkpoint served as it stands, or a Hugging Face repo id (owner/name), fetched before startup | none (required) | path | user | `core/config.cpp:49` |
| `model-revision` | a model (or `defaults:`) | the hub revision -- a branch, tag, full commit sha or refs/pr/N -- a repo id is fetched at; default the repo's moving main branch | main | branch, tag, commit or refs/pr/N | user | `core/config.cpp:53` |
| `download-dir` | `server:` | where a repo id is fetched to; default $XDG_CACHE_HOME/radiance/hf, else ~/.cache/radiance/hf | $XDG_CACHE_HOME/radiance/hf, else ~/ | folder | user | `core/config.cpp:51` |
| `radiance-home` | `server:` | where kernels/, architectures/ and quantizers/ live; several homes separated by ':' are searched in order, the first winning | beside the executable (`share\radiance` in a package); else `RADIANCE_HOME` | folders separated by `:` | developer | `core/config.cpp:55` |
| `kernels` | `server:` | the kernel libraries to use, separated by ',' or ':', first wins; unnamed ones are not loaded. Default: every library found | every library found; else `RADIANCE_KERNELS` | comma-separated list | developer | `core/config.cpp:57` |
| `terms-file` | `server:` | the terms of use GET /terms serves, a UTF-8 file (.html or .htm as HTML, else plain text); an unreadable or empty file stops startup. Default: the built-in template (TERMS-OF-USE.md) | the built-in template | path | operator | `core/config.cpp:357` |
| `generation-config` | a model (or `defaults:`) | a generation_config.json whose sampler settings become the default for requests that send none. Without it a <model>.generation.json beside the container is used, then the container's own generation.* metadata, then the built-in defaults | the container's | path | operator | `core/config.cpp:373` |
| `override-chat-template` | a model (or `defaults:`) | a Jinja chat template file, used in place of the one the container carries | the container's template | path | operator | `core/config.cpp:377` |
| `chat-template-kwargs` | a model (or `defaults:`) | variables handed to the chat template on every chat request: a JSON object, or @FILE to read one. Repeatable, a later key replacing an earlier one. A key the request's own chat_template_kwargs names is the request's, and a request that says anything about thinking replaces enable_thinking and reasoning_effort here | none | JSON | operator | `core/config.cpp:422` |
| `reasoning-format` | a model (or `defaults:`) | auto (default): a reasoning block comes back as reasoning_content. none: it stays inline in content | auto | a mode | operator | `core/config.cpp:427` |
| `rope-scaling` | a model (or `defaults:`) | yarn:FACTOR[:ORIG]: static YaRN over the container's own rotary keys, no reconvert (docs/YARN.md); none: off | none | spec | operator | `core/config.cpp:114` |

### Listening, keys and HTTP limits (under `server:`)

<!-- settings: yaml -->

| Key | Level | Meaning | Default | Values | Who | Read at |
|---|---|---|---|---|---|---|
| `host` | `server:` | listen address. Serving beyond loopback requires an explicit address here or `serve.ps1 -Listen`. **Safety:** `0.0.0.0` listens on every IPv4 interface. A keyless listener beyond loopback logs a startup warning. | 127.0.0.1 | IP address or host name | user | `core/config.cpp:345` |
| `port` | `server:` | listen port | 8000 | whole number | user | `core/config.cpp:346` |
| `api-key` | `server:` | require Authorization: Bearer KEY or X-Api-Key: KEY on every request but /health, /v1/health, /ping (the status alone), the dashboard page and /terms **Safety:** a key written into a file. Prefer `api-key-env`; `serve.ps1 -Install` refuses a profile that holds one. | none | text | operator | `core/config.cpp:347` |
| `api-key-env` | `server:` | read the API key from the named environment variable; keeps it off the command line, where every process on the machine can read it An unset or empty variable stops startup rather than serving without a key. | none | name | user | `core/config.cpp:349` |
| `allow-host` | `server:` | a Host name the keyless loopback-only routes (/diagnostics, /admin/control-vector, the LoRA and session admin) accept besides localhost; repeatable Widens the keyless loopback-only admin routes to another Host name. | none (localhost only) | name | operator | `core/config.cpp:351` |
| `trusted-proxy` | `server:` | a network whose sockets may name the client behind them via X-Forwarded-For, for the log; vouching changes attribution, never access; repeatable Changes log attribution only, never access. | none | network (CIDR) | operator | `core/config.cpp:354` |
| `http-threads` | `server:` | HTTP workers kept while idle (default: one per core, at least 4) | one per core, at least 4 | whole number | operator | `core/config.cpp:430` |
| `read-timeout` | `server:` | seconds a client may go silent while sending a request (default 30) | 30 | seconds | operator | `core/config.cpp:431` |
| `write-timeout` | `server:` | seconds one write to a client may block (default 600) | 600 | seconds | operator | `core/config.cpp:432` |
| `keep-alive-timeout` | `server:` | seconds an idle connection is held open between requests (default 5) | 5 | seconds | operator | `core/config.cpp:433` |
| `max-body-mib` | `server:` | the largest request body; images and video arrive base64 inside it (default 512) | 512 | whole number | operator | `core/config.cpp:434` |
| `retry-after` | `server:` | the Retry-After a 429 carries, in seconds (default 1) | 1 | seconds | operator | `core/config.cpp:436` |
| `no-cors` | `server:` | send no CORS headers, so a page on another origin cannot read the API | false (CORS on) | true \| false (a switch) | operator | `core/config.cpp:437` |
| `live` | `server:` | the live view: cards, throughput, draft acceptance, the expert plane. Redirected it prints one greppable key=value line instead | false | true \| false (a switch) | user | `core/config.cpp:528` |

**A taken port is refused.** The server binds its `host` and `port` exclusively. If another server, or any
other program, already listens on them, the start stops before serving, with
`E server: cannot bind 127.0.0.1:8000: the port is already in use; ...`, and radiance exits 1. Stop the
other server or choose another `port`. A port Windows reserves (see
`netsh int ipv4 show excludedportrange protocol=tcp`) is refused with "access to the port was denied".
A restart on the same port right after a stop binds normally.

### Cards, tensor parallel and the link between cards

<!-- settings: yaml -->

| Key | Level | Meaning | Default | Values | Who | Read at |
|---|---|---|---|---|---|---|
| `tp` | a model (or `defaults:`) | tensor-parallel ranks | 1 | whole number | user | `core/config.cpp:59` |
| `tp-wire` | a model (or `defaults:`) | cross-rank all-reduce payload: exact (default) or wht6, a lossy wire: rotated 6-bit at 2 ranks, tiered int8 at 3 and 4, none at 8 wht6 is lossy: output is no longer bit-identical to the exact wire. | exact | a mode | operator | `core/config.cpp:60` |
| `tp-wire-min-kb` | a model (or `defaults:`) | smallest all-reduce, in KiB, the lossy wire is used for | 128 | whole number | operator | `core/config.cpp:63` |
| `tp-attn-split` | a model (or `defaults:`) | heads (default) \| rows -- how a prefill-sized step's attention splits over the ranks: rows gives each rank all heads of its rows, a faster prefill for the projections at full width on every card; not bit-identical to heads | heads | heads \| rows | operator | `core/config.cpp:64` |
| `weight-prefetch` | a model (or `defaults:`) | on (default) \| off -- read a GEMM's weight into the cache beside the collective before it; off for an engine that shares its cards with another server. On Windows, where the cards exchange through pinned host memory, off is faster: Qwen3.8-Flash-Next at TP2 updated in 13.1 ms against 18.2 ms, +37% single-stream decode, greedy text identical, prefill unchanged, so every shipped two- and four-card profile sets off. The default stays on for cards that exchange directly (docs/GUIDE.md section 4.11) | on | on \| off | operator | `core/config.cpp:68` |
| `p2p` | a model (or `defaults:`) | how the collectives reach the other cards: auto (default) asks the driver, on requires peer access and stops without it, off exchanges through pinned host memory | auto | a mode | operator | `core/config.cpp:71` |

### Memory and where weights live

<!-- settings: yaml -->

| Key | Level | Meaning | Default | Values | Who | Read at |
|---|---|---|---|---|---|---|
| `gpu-memory-mib` | `memory:` or a model | VRAM claimed on every card; the rest is left unclaimed. Not with gpu-headroom-mib | 0 (unset: `gpu-headroom-mib` applies) | whole number | user | `core/config.cpp:117` |
| `gpu-headroom-mib` | `memory:` or a model | VRAM left unclaimed on every card (default 96). Not with gpu-memory-mib | 96 | whole number | user | `core/config.cpp:119` |
| `host-headroom-mib` | `memory:` or a model | host RAM to leave free for the system when radiance pins its host memory at startup (default 4096) **Safety:** lowering it leaves Windows less free RAM while radiance pins its host memory. | 4096 | whole number | operator | `core/config.cpp:134` |
| `host-pool-mib` | a model (or `defaults:`) | pinned host tier for weights, in all: the ranks of a model pin equal shares of it (N / tp each) **Safety:** pinned host memory comes out of the Windows pin budget (see `BRILLIANCE_PIN_LIMIT_GIB`); leave the machine room (`host-headroom-mib`). | 0 (no host pool) | whole number | operator | `core/config.cpp:132` |
| `kv-cache-dtype` | a model (or `defaults:`) | bf16 (default) \| i8 \| fp8 -- i8 halves what a token of context costs: K and V as int8 with one scale each per token and head. fp8 (E4M3) is GLM-5.3's latent cache only | bf16 | bf16 \| i8 \| fp8 | user | `core/config.cpp:121` |
| `state-cache-dtype` | a model (or `defaults:`) | f32 (default) \| f16 -- the recurrent state cache (delta net): f16 halves the state pool, its checkpoints and its traffic, and is lossy; the qwen35 plugins serve it | f32 | f32 \| f16 | operator | `core/config.cpp:124` |
| `kv-resident` | a model (or `defaults:`) | stream the sparse attention group's KV from host memory, keeping N tokens of it in a VRAM ring (0, the default, is off). Raised to 32768 and to what one decode step selects; a ring that covers the context (sequences x max-model-len) streams nothing | 0 (off) | whole number | operator | `core/config.cpp:127` |
| `placement` | a model (or `defaults:`) | the placement strategy: all_vram keeps every weight on the cards; layer_offload and expert_tiered put some in the host pool or on the disk tier; auto picks the first that fits | auto | all_vram \| layer_offload \| expert_tiered \| auto | operator | `core/config.cpp:203` |
| `embedding-placement` | a model (or `defaults:`) | ram (default) \| vram: where the token embedding lives. ram pins it in host memory beside host-pool-mib, read over the link in place; by default a model whose output head reads the table, or a host without the memory, keeps it on the card | ram | ram \| vram | operator | `core/config.cpp:136` |
| `vision-tower-placement` | a model (or `defaults:`) | vram (default) \| ram: where the encoder towers live (the vision tower; the audio encoder too). ram pins them in host memory beside host-pool-mib, read over the link once an image, and gives their VRAM to the KV cache | vram | vram \| ram | operator | `core/config.cpp:140` |
| `ngram-placement` | a model (or `defaults:`) | auto (default) \| vram \| ram \| disk: where an n-gram embedding table lives (Qwen3.8-Flash-Next: 47.7 GiB). vram puts all of it on every card; ram copies it into host memory at load, pinned for the cards to read (locked, where only a host kernel reads it); disk reads its rows from the container on the host. auto takes the first of the three that holds it. ram=DIR makes the pinned copy a file in DIR (a tmpfs) mapped shared, so two engines on separate cards hold one table: the first fills it, the last to exit deletes it | auto | auto \| vram \| ram \| disk | operator | `core/config.cpp:144` |
| `ngram-warm` | a model (or `defaults:`) | read an n-gram table on the disk tier once at load into the OS file cache (Windows, where the gather reads the container's mapping). The cache remains reclaimable. Startup skips warming and logs why unless available memory covers the table plus the larger of 24 GiB and the configured host headroom. | false | true \| false (a switch) | operator | `core/config.cpp:154` |
| `weights-disk-tier` | a model (or `defaults:`) | read weights that fit neither VRAM nor the host pool from the container on disk (O_DIRECT) -- the file tier, units on Tier::SSD; a routed expert is read a layer at a time, so a step is paced by the drive | false | true \| false (a switch) | operator | `core/config.cpp:159` |
| `weights-file-relayout` | a model (or `defaults:`) | with weights-disk-tier, let the file tier take a routed expert whose kernel relays its container planes: read and relaid on every read (one whole, unsharded expert at a time) | false | true \| false (a switch) | operator | `core/config.cpp:163` |
| `expert-ram-mib` | a model (or `defaults:`) | with weights-disk-tier, keep up to N MiB (all ranks together) of the routed experts the cards and the host pool cannot hold in ordinary RAM, read and relaid once at load; a step copies them through the pinned read windows, and the rest stay on the drive. Refused unless 24 GiB of RAM stays free Refused unless 24 GiB of RAM stays free. | 0 | whole number | operator | `core/config.cpp:166` |
| `expert-profile` | a model (or `defaults:`) | rank the expert plane by this radiance-expert-stats JSON's decode counts instead of the container's activation profile, which is prefill-heavy: decode-hot experts differ. The planner keeps the hottest resident; expert-pin-top makes a chosen slice unmovable | none | file | operator | `core/config.cpp:516` |
| `expert-pin-top` | a model (or `defaults:`) | pin the hottest fraction F of the routed experts (0 < F <= 1) by expert-profile's share: heat never demotes them, so the decode-hot set stays resident while the rest streams. 0 is off | 0 (off) | number | operator | `core/config.cpp:520` |
| `draft-expert-placement` | a model (or `defaults:`) | where a draft head's (MTP/DSpark) routed experts live. host pins them in the host pool before any strategy runs, read in place like a pooled expert: the drafter's experts fit beside a trunk that already fills the card, instead of the strategy having to make room on the card. auto (the default) leaves them to the strategy | auto | auto \| host | operator | `core/config.cpp:523` |
| `deterministic` | a model (or `defaults:`) | pin placement to the plan the loader made, so the resident set cannot change under the heat engine. The sampler is already order-independent and needs no pinning; note that this does NOT make the engine bit-reproducible across batch positions Not bit-reproducible across batch positions. | false | true \| false (a switch) | operator | `core/config.cpp:213` |

### Context, batching and scheduling

<!-- settings: yaml -->

| Key | Level | Meaning | Default | Values | Who | Read at |
|---|---|---|---|---|---|---|
| `max-model-len` | a model (or `defaults:`) | context bound; 0 takes the model's training context | 0 (the model's training context) | whole number | user | `core/config.cpp:113` |
| `max-num-seqs` | a model (or `defaults:`) | the largest number of sequences one step may carry | 256 | whole number | user | `core/config.cpp:112` |
| `max-num-batched-tokens` | a model (or `defaults:`) | the largest token count one step may carry | 2048 | whole number | operator | `core/config.cpp:74` |
| `busy-prefill-chunk` | a model (or `defaults:`) | a prefill chunk's share of a step that has other work: auto (default) leaves decode rows and new requests their room, off takes the whole step, N holds the chunk to N tokens | auto | a mode | operator | `core/config.cpp:75` |
| `prefill-interleave` | a model (or `defaults:`) | decode-only steps after each prefill chunk while other sequences decode, at most 64; auto fits them in a quarter of the chunk step's time, auto:SHARE in SHARE of it (0-4]; 0 lets every step carry a chunk; served default auto:1 (0 under deterministic, KL mode, generators) | auto:1 | whole number | operator | `core/config.cpp:78` |
| `mixed-step-target-ms` | a model (or `defaults:`) | soft duration target in milliseconds for a mixed prefill/decode step. The scheduler learns an aggregate prefill cap from completed mixed steps; 0 (default) is off | 0 | whole number | operator | `core/config.cpp:83` |
| `prefill-room-gate` | a model (or `defaults:`) | on: a fresh prefill starts only when its whole prompt plus one decode position fits beside every runner; off (the default) admits a prompt when its first chunk fits | off | a mode | operator | `core/config.cpp:86` |
| `admit-kv-reserve` | a model (or `defaults:`) | hold a new request until its whole prompt plus N tokens of output reserve fit beside every runner's remaining prompt and reserve; 0 is off | 0 (off) | whole number | operator | `core/config.cpp:97` |
| `admit-backfill-ms` | a model (or `defaults:`) | how long smaller requests may pass a request held by `admit-kv-reserve` before the queue drains for it; 0 lets nothing pass | 0 | whole number (ms) | operator | `core/config.cpp:101` |
| `admit-claimant` | a model (or `defaults:`) | on: the frontmost held waiter past `admit-backfill-ms` claims the next pool room and gates fillers so they cannot push its anchor later; inert without `admit-kv-reserve` and `admit-backfill-ms` | false | true \| false (a switch) | operator | `core/config.cpp:104` |
| `admit-claimant-min-pct` | a model (or `defaults:`) | minimum share of the binding full KV group (0-100%) a held waiter must need to become a claimant; 0 lets any held waiter claim | 50 | 0-100 | operator | `core/config.cpp:109` |
| `preempt-wait-ms` | a model (or `defaults:`) | how long a preempted prefill may wait for the whole- recompute gate before reclaiming cache blocks and preempting the lowest-priority running request; 0 (default 5000) falls back on the next step | 5000 | whole number | operator | `core/config.cpp:89` |
| `flex-wait-ms` | a model (or `defaults:`) | how long a running request whose KV growth waits on the fleet is held, without preempting anyone, before the shortfall is preemption's to fix; 0 = no wait (default 60000) | 60000 | whole number | operator | `core/config.cpp:93` |
| `prefill-span` | a model (or `defaults:`) | checkpoint intervals one step may carry of a prefill alone in its step, from the prompt's second interval on (default 1); needs max-num-batched-tokens of N intervals. Prompts prefilling side by side with nothing decoding take such steps one at a time, the fewest tokens left first. Every other step is planned at the budget less the extra intervals, and the checkpoints inside a span are not written | 1 | whole number | operator | `core/config.cpp:219` |
| `prefill-span-pass` | a model (or `defaults:`) | piece (default) \| step -- the routed (MoE) block's pass of a spanned step: a pass an interval, or one pass over the whole step where the model runs such a step serially (Flash-Next at one or two ranks). Each expert's weight is then read once for all the step's rows; the arena grows by the expert planes' extra rows and the output differs from piece passes at tie level. Needs prefill-span above 1 | piece | piece \| step | operator | `core/config.cpp:227` |
| `prefill-span-first` | a model (or `defaults:`) | off (default) \| on -- whether a lone prefill may span from its first token; on: the first interval rides the span (its rows read QSA's selection, the same keys as the dense pass below the exactness bound, summed in another order) | off | off \| on | operator | `core/config.cpp:241` |
| `prefill-span-min` | a model (or `defaults:`) | the shortest prompt, in tokens, a prefill spans for: auto (default) is 8 intervals where routed experts are read from host memory and 0 elsewhere; 0 spans every lone prefill | auto | whole number | operator | `core/config.cpp:245` |
| `prefill-tail-snapshot` | a model (or `defaults:`) | on (default): a prompt's last chunk ends where the next turn's linear-state snapshot goes (prefix resume nearest), leaving its last tokens a step of their own (a lone spanned prefill on a model that snapshots inside a step takes it inside the chunk, no step more); off: the last chunk runs to the prompt's end, one step fewer, and a next turn resumes up to an interval earlier | on | a mode | operator | `core/config.cpp:234` |

### Prefix cache and state checkpoints

<!-- settings: yaml -->

| Key | Level | Meaning | Default | Values | Who | Read at |
|---|---|---|---|---|---|---|
| `prefix-cache-mib` | a model (or `defaults:`) | copy finished conversations' KV to host memory, up to N MiB, so their VRAM can go to experts and a return restores instead of re-prefilling. A full tier drops its least recently used entries. 0 is off. Off while a KV group streams (kv-resident) **Safety:** pinned host memory, from the same budget as `host-pool-mib`. | 0 (off) | whole number | operator | `core/config.cpp:174` |
| `prefix-cache-file` | a model (or `defaults:`) | save live host KV blocks and linear-state checkpoints to PATH on clean unload/shutdown and restore them on next load (local) | off | path | operator | `core/config.cpp:182` |
| `prefix-cache-ttl` | a model (or `defaults:`) | seconds a cached conversation no request uses is kept, in VRAM or host memory (default 3600). 0 keeps it until the memory is wanted | 3600 | seconds | operator | `core/config.cpp:179` |
| `no-prefix-cache` | a model (or `defaults:`) | disable prefix caching | false (prefix caching on) | true \| false (a switch) | operator | `core/config.cpp:255` |
| `prefix-resume` | a model (or `defaults:`) | where a prefix hit resumes: exact (default) only where an idle server's cold prefill of the prompt starts a chunk, so the hit answers bit-identically to a cold run; nearest at the deepest snapshot, up to a chunk less to re-prefill | exact | a mode | operator | `core/config.cpp:256` |
| `checkpoint-interval` | a model (or `defaults:`) | linear-attention state checkpoint interval, in tokens | 2048 | whole number | operator | `core/config.cpp:218` |
| `checkpoint-slots` | a model (or `defaults:`) | linear-state or sliding-window snapshots the server holds in total, in pinned host memory. Default auto: what checkpoint-policy keeps for a max-model-len session, plus one, for each of max-num-seqs, within an eighth of host memory. N fixes the total; 0 keeps none Pinned host memory. | auto | whole number | operator | `core/config.cpp:250` |
| `checkpoint-policy` | a model (or `defaults:`) | which snapshots a session retains: geometric-backoff (default), tip-only, keep-all | geometric-backoff | name | operator | `core/config.cpp:261` |

### Speculative decoding (drafting)

<!-- settings: yaml -->

| Key | Level | Meaning | Default | Values | Who | Read at |
|---|---|---|---|---|---|---|
| `num-speculative-tokens` | a model (or `defaults:`) | speculative window; 0 disables. Default auto: the drafter's own operating point, which the plugin states. A container with no draft head is unaffected -- auto resolves to 0. | auto (the drafter's own operating point) | whole number | user | `core/config.cpp:264` |
| `spec-ngram` | a model (or `defaults:`) | speculate by prompt lookup alone: up to K drafts a step copied from what followed the latest earlier occurrence of the sequence's last n tokens (no weights, no draft pass). Sets the window to K; a draft head the container carries is not loaded. A proposal is verified only when its record says it pays at the measured step cost. 0 (default) off | 0 | whole number | operator | `core/config.cpp:267` |
| `spec-ngram-min` | a model (or `defaults:`) | shortest pattern prompt lookup matches (default 2) | 2 | whole number | operator | `core/config.cpp:273` |
| `spec-ngram-max` | a model (or `defaults:`) | longest pattern prompt lookup matches, tried first (default 4, at most 15) | 4, at most 15 | whole number | operator | `core/config.cpp:274` |
| `draft-window` | a model (or `defaults:`) | fixed \| adaptive: how many drafts each sequence carries. fixed drafts num-speculative-tokens every step; adaptive makes that the ceiling and follows each sequence's acceptance and the measured step cost | fixed | fixed \| adaptive | operator | `core/config.cpp:276` |
| `draft-short-from` | a model (or `defaults:`) | a block drafter that also serves a shorter block runs it from N decoding sequences on (0 never): the long block pays at one sequence, the short one at many. auto (the default): never for a chain, from 2 for a tree drafter | auto | whole number | operator | `core/config.cpp:277` |
| `draft-coupling` | a model (or `defaults:`) | off (default) \| on -- a linear MTP drafter or DFlash2's walk samples each proposal from its own shortlist and the sampler couples the target's draw to it: more accepted drafts on sampled requests, the same output law, other tokens than off for a fixed seed | off | off \| on | operator | `core/config.cpp:281` |
| `draft-verify` | a model (or `defaults:`) | token (default, alias rowwise) \| block \| traversal -- how a coupled draft chain is verified: token decides each row on its own (maximal coupling); block decides the whole chain at once (Block Verification, arXiv 2403.10444; switches draft-coupling on); traversal decides a root-to-leaf path bottom-up (Traversal Verification, arXiv 2505.12398; needs draft-coupling on). The same output law in every mode, more drafts accepted per step in block and traversal | token | token \| block \| traversal | operator | `core/config.cpp:286` |
| `draft-depth` | a model (or `defaults:`) | fixed (default) \| adaptive -- a coupled serial chain stops within the step once the product of the head's probabilities along it falls below draft-depth-stop, and the next verify carries only the drafts made (1 .. draft-depth-max). Same output law (the rule reads the draft's own laws only); switches draft-coupling on (an explicit off is refused) and needs draft-window fixed (both choose the depth, so they are not served together) | fixed | fixed \| adaptive | operator | `core/config.cpp:293` |
| `draft-depth-max` | a model (or `defaults:`) | draft-depth adaptive: the deepest chain (default 0 = num-speculative-tokens) | 0 (= num-speculative-tokens) | whole number | operator | `core/config.cpp:300` |
| `draft-depth-min` | a model (or `defaults:`) | draft-depth adaptive: rounds that always run (default 1) | 1 | whole number | operator | `core/config.cpp:302` |
| `draft-depth-stop` | a model (or `defaults:`) | draft-depth adaptive: the chain goes on while its confidence is at least P (default 0.85) | 0.85 | probability (0, 1] | operator | `core/config.cpp:303` |
| `draft-depth-lag` | a model (or `defaults:`) | draft-depth adaptive: rounds the decision trails the chain, 0 or 1 (default 1: the host decides while the next round runs) | 1 | whole number | operator | `core/config.cpp:305` |
| `draft-depth-stat` | a model (or `defaults:`) | draft-depth adaptive: top (default, each round's largest probability) \| path (the probability of the token it drew) | top | seconds | operator | `core/config.cpp:307` |
| `draft-depth-load` | a model (or `defaults:`) | off (default) \| on -- draft-depth adaptive with several sequences in a step: draft round j only for the rows whose expected accepted drafts pay their verify rows, the kernel tile they open and the round, at the measured throughput; fewer sequences than draft-depth-load-from keep the stop rule. Same output law | off | off \| on | operator | `core/config.cpp:309` |
| `draft-depth-load-from` | a model (or `defaults:`) | draft-depth-load: the fewest drafting sequences of a step the load-aware rule decides (default 5) | 5 | whole number | operator | `core/config.cpp:315` |
| `draft-depth-load-min` | a model (or `defaults:`) | draft-depth-load: rounds a load-aware step always runs (default 2) | 2 | whole number | operator | `core/config.cpp:317` |
| `draft-depth-load-late` | a model (or `defaults:`) | on (default) \| off -- draft-depth-load: choose each row's verified drafts again when the next verify is issued, from the laws read by then | on | on \| off | operator | `core/config.cpp:318` |
| `draft-depth-load-calib` | a model (or `defaults:`) | draft-depth-load: online (default; acceptance by confidence, throughput and row/round/tile prices follow the running server) \| static (the built-in or given tables only) | on | a mode | developer | `core/config.cpp:320` |
| `draft-depth-load-tok-ms` | a model (or `defaults:`) | draft-depth-load: tokens a millisecond by drafting sequences 1..8, comma-separated (a short list repeats its last; default built in) | built in | comma-separated list | developer | `core/config.cpp:323` |
| `draft-depth-load-row-ms` | a model (or `defaults:`) | draft-depth-load: a verify row's milliseconds, by drafting sequences 1..8 | built in | comma-separated list | developer | `core/config.cpp:325` |
| `draft-depth-load-round-ms` | a model (or `defaults:`) | draft-depth-load: a draft round's milliseconds, by drafting sequences 1..8 | built in | comma-separated list | developer | `core/config.cpp:327` |
| `draft-depth-load-jump-ms` | a model (or `defaults:`) | draft-depth-load: what a verify of more than 16, 32, 48, 64 rows costs on top, in milliseconds (four numbers) | built in | comma-separated list | developer | `core/config.cpp:329` |
| `draft-suffix` | a model (or `defaults:`) | off (default) \| on -- SuffixDecoding as a step selector on a serial head's chain: when the sequence's last draft-suffix-min-match tokens occurred earlier in its own prompt ++ output, a host-built step verifies the earlier continuation (a chain, up to draft-suffix-max rows) instead of the head's draft. Lossless; works beside the fixed chain, draft-verify traversal and draft-depth adaptive, not draft-verify block | off | off \| on | operator | `core/config.cpp:331` |
| `draft-suffix-min-match` | a model (or `defaults:`) | shortest suffix match that selects a suffix step (default 6) | 6 | whole number | operator | `core/config.cpp:337` |
| `draft-suffix-max` | a model (or `defaults:`) | most rows of a suffix step (default 7; the verify window becomes max(num-speculative-tokens, N), the head still drafts its own) | 7 | whole number | operator | `core/config.cpp:338` |
| `draft-suffix-min-score` | a model (or `defaults:`) | cut the suffix chain where its path score (the product of the follower frequencies along it, SuffixDecoding's D) falls under D (default 0.3) | 0.3 | number | operator | `core/config.cpp:340` |
| `draft-model` | a model (or `defaults:`) | not implemented: refused. Merge the drafter at convert time (rad-convert draft-model) Refused at startup. | none | path | developer | `core/config.cpp:343` |

### LoRA adapters and control vectors

<!-- settings: yaml -->

| Key | Level | Meaning | Default | Values | Who | Read at |
|---|---|---|---|---|---|---|
| `lora` | a model (or `defaults:`) | NAME=PATH: serve a LoRA adapter beside the base model (repeatable). A text model takes a PEFT directory and serves it as model NAME; an image or video generator takes a .safetensors file (kohya, ComfyUI, PEFT, LyCORIS) that a request names in loras. The base stays as it is | none | NAME=PATH | operator | `core/config.cpp:185` |
| `lora-dir` | a model (or `defaults:`) | image and video generators: a request may name any NAME.safetensors under DIR in loras, opened when first asked for | none | folder | operator | `core/config.cpp:190` |
| `max-loras` | a model (or `defaults:`) | adapter slots resident at once (default: the number of lora, 2 with lora-dir alone). A text model's slot holds one adapter, a generator's one request's combination | the number of `lora` entries; 2 with `lora-dir` alone | whole number | operator | `core/config.cpp:193` |
| `max-lora-rank` | a model (or `defaults:`) | the rank each slot is sized for (default 16 for a text model, 64 for a generator); a text model's larger adapter is refused, a generator's larger combination truncated | 16 (text), 64 (generator) | whole number | operator | `core/config.cpp:196` |
| `lora-target-modules` | a model (or `defaults:`) | comma-separated HF module leaf names adapters may target (q_proj,k_proj,...). Default: what the lora adapters target. Needed with max-loras and no lora | what the adapters target | comma-separated list | operator | `core/config.cpp:199` |
| `control-vector` | a model (or `defaults:`) | off \| on \| disabled: load the control-vector file found for this model and start requests off (off) or on (on). disabled -- the default, also with no flag at all -- loads nothing: no projection op is declared, and a request that asks for the vector is refused | disabled | off \| on \| disabled | operator | `core/config.cpp:204` |
| `control-vector-variant` | a model (or `defaults:`) | list MODEL:NAME, a name of this model whose requests run with the control vector on; the model's own name keeps control-vector's default. Needs control-vector off or on | the file's first | name | operator | `core/config.cpp:209` |

### Sampling defaults (a request that names the field wins)

GC: the model's generation config: `generation-config:`, else `<model>.generation.json` beside the container, else the container's `generation.*` metadata.

<!-- settings: yaml -->

| Key | Level | Meaning | Default | Values | Who | Read at |
|---|---|---|---|---|---|---|
| `temp` | a model (or `defaults:`) | default temperature for requests that do not set one | GC, else 1.0 | number | user | `core/config.cpp:378` |
| `top-k` | a model (or `defaults:`) | default top_k for requests that do not set one; 0 is the 1024 most likely tokens, the sampler's candidate width | GC, else 0 (the 1024 most likely) | whole number | user | `core/config.cpp:379` |
| `top-p` | a model (or `defaults:`) | default top_p for requests that do not set one | GC, else 1.0 | number | user | `core/config.cpp:381` |
| `min-p` | a model (or `defaults:`) | default min_p (0 = off) for requests that do not set one. These four override whatever the container or its generation config asked for; unset, they are resolved from it | GC, else 0 | number | user | `core/config.cpp:382` |
| `typical-p` | a model (or `defaults:`) | default typical_p for requests that do not set one, (0, 1] | GC, else 1 (off) | number | operator | `core/config.cpp:398` |
| `presence-penalty` | a model (or `defaults:`) | default presence_penalty, [-2, 2] | GC, else 0 | number | operator | `core/config.cpp:400` |
| `frequency-penalty` | a model (or `defaults:`) | default frequency_penalty, [-2, 2] | GC, else 0 | number | operator | `core/config.cpp:401` |
| `repetition-penalty` | a model (or `defaults:`) | default repetition_penalty, > 0 | GC, else 1 (off) | number | operator | `core/config.cpp:402` |
| `repeat-last-n` | a model (or `defaults:`) | default repeat_last_n, the tokens those penalties look back over; -1 is all | GC, else 64 | whole number | operator | `core/config.cpp:403` |
| `dry-multiplier` | a model (or `defaults:`) | default dry_multiplier; 0 is DRY off | GC, else 0 (off) | number | operator | `core/config.cpp:404` |
| `dry-base` | a model (or `defaults:`) | default dry_base, >= 1 | GC, else 1.75 | number | operator | `core/config.cpp:405` |
| `dry-allowed-length` | a model (or `defaults:`) | default dry_allowed_length, >= 1 | GC, else 2 | whole number | operator | `core/config.cpp:406` |
| `dry-penalty-last-n` | a model (or `defaults:`) | default dry_penalty_last_n; -1 is the whole context | GC, else -1 (all) | whole number | operator | `core/config.cpp:407` |
| `dry-sequence-breakers` | a model (or `defaults:`) | default dry_sequence_breakers, a JSON array of at most 16 strings | GC, else the sampler's built-in list | JSON | operator | `core/config.cpp:408` |
| `xtc-probability` | a model (or `defaults:`) | default xtc_probability, [0, 1] | GC, else 0 (off) | number | operator | `core/config.cpp:409` |
| `xtc-threshold` | a model (or `defaults:`) | default xtc_threshold, [0, 1] | GC, else 0.1 | number | operator | `core/config.cpp:410` |
| `reasoning-effort` | a model (or `defaults:`) | default reasoning_effort for chat requests that do not set one. The value goes to the model's chat template verbatim, so the legal set is the template's: Qwen3.8 takes xhigh\|medium\|low and defaults to xhigh, which on a short task can spend the whole token budget inside <think> and answer nothing. "none" turns thinking off | none (the template's own) | seconds | user | `core/config.cpp:385` |
| `reasoning-effort-map` | a model (or `defaults:`) | FROM=TO[,FROM=TO...]: a reasoning_effort a request sends, replaced before the chat template sees it -- high=xhigh lets a client that always sends OpenAI's top level reach Qwen3.8's. TO is checked against the template at startup; none and minimal turn thinking off. Repeatable | none | FROM=TO list | operator | `core/config.cpp:390` |
| `thinking-token-budget` | a model (or `defaults:`) | default thinking_token_budget for chat requests that do not set one: at N reasoning tokens the reasoning block is closed and the answer follows, so a client's max_tokens is not spent on reasoning alone. Unset is no limit. Needs a reasoning block that ends in one token, as </think> is | none | whole number | operator | `core/config.cpp:394` |

### Request limits

<!-- settings: yaml -->

| Key | Level | Meaning | Default | Values | Who | Read at |
|---|---|---|---|---|---|---|
| `default-max-tokens` | a model (or `defaults:`) | max_tokens for requests that do not set one: N, or auto (default), whatever the context leaves after the prompt | auto | whole number | user | `core/config.cpp:411` |
| `max-tokens-cap` | a model (or `defaults:`) | the most any request may generate. A larger max_tokens is cut to it rather than refused, and the reply ends with finish_reason "length". 0 is none (default) | none | whole number | operator | `core/config.cpp:413` |
| `max-n` | a model (or `defaults:`) | the largest n a request may ask for (default: the larger of 8 and max-num-seqs) | the larger of 8 and max-num-seqs | whole number | operator | `core/config.cpp:416` |
| `max-queued-requests` | a model (or `defaults:`) | requests admitted and unfinished at once, past which the answer is 429 (default 8 x max-num-seqs) | 8 x max-num-seqs | whole number | operator | `core/config.cpp:418` |
| `max-stop-strings` | a model (or `defaults:`) | stop strings one request may send (default 64) | 64 | whole number | operator | `core/config.cpp:420` |
| `max-stop-bytes` | a model (or `defaults:`) | bytes in one stop string (default 4096) | 4096 | whole number | operator | `core/config.cpp:421` |

### Images, video and generation

<!-- settings: yaml -->

| Key | Level | Meaning | Default | Values | Who | Read at |
|---|---|---|---|---|---|---|
| `mm-max-patches` | a model (or `defaults:`) | patches one encoder pass carries, and so the largest image (a patch is 16x16 pixels). Default auto: 16384 when the container carries a vision tower (0 in a build without a media decoder, which would refuse every media part). 0 serves text only and keeps the tower off the card | auto (16384 with a vision tower) | whole number | operator | `core/config.cpp:361` |
| `mm-audio-frames` | a model (or `defaults:`) | mel frames one audio encoder pass carries (Qwen3-ASR: 104 frames/s). Default auto: the model's pass (3120 = 30 s). 0 disables audio | auto (the model's) | whole number | operator | `core/config.cpp:365` |
| `image-min-pixels` | a model (or `defaults:`) | an image is resized to at least N pixels before encoding | the container's | whole number | operator | `core/config.cpp:439` |
| `image-max-pixels` | a model (or `defaults:`) | an image is resized to at most N pixels; one encoder pass (mm-max-patches) still bounds it | the container's | whole number | operator | `core/config.cpp:440` |
| `image-tokens` | a model (or `defaults:`) | a token-budget processor's image budget (Gemma 4: 70, 140, 280, 560, 1120, which a request's image_tokens overrides; GLM-5.3: the most tokens an image becomes, at most mm-max-patches / 4; default the container's) | the container's | whole number | operator | `core/config.cpp:448` |
| `video-min-pixels` | a model (or `defaults:`) | a video frame is resized to at least N pixels | the container's | whole number | operator | `core/config.cpp:441` |
| `video-max-pixels` | a model (or `defaults:`) | a video frame is resized to at most N pixels | the container's | whole number | operator | `core/config.cpp:442` |
| `video-fps` | a model (or `defaults:`) | frames sampled per second of video | the container's | number | operator | `core/config.cpp:443` |
| `video-min-frames` | a model (or `defaults:`) | the fewest frames sampled from a video | the container's | whole number | operator | `core/config.cpp:444` |
| `video-max-frames` | a model (or `defaults:`) | the most frames sampled from a video | the container's | whole number | operator | `core/config.cpp:445` |
| `video-max-frame-tokens` | a model (or `defaults:`) | the most tokens one video frame becomes | the container's | whole number | operator | `core/config.cpp:446` |
| `max-source-pixels` | a model (or `defaults:`) | the largest image or video frame the decoder accepts, before any resize (default 67108864). The media flags above default to what the container states, and do nothing for a model that takes no media | 67108864 | whole number | operator | `core/config.cpp:451` |
| `image-gen-max-pixels` | a model (or `defaults:`) | an image generator's largest image, in pixels (1048576: 1024 x 1024). Default: the model's. Its per-image buffers, and the activation arena with them, are sized for it; larger requests are refused | the model's | whole number | operator | `core/config.cpp:368` |
| `image-gen-max-refs` | a model (or `defaults:`) | the reference pictures an image generator takes a request. Default: the model's; its conditioning buffers are sized for them | the model's | whole number | operator | `core/config.cpp:371` |

### Measurement, calibration and debugging (developer)

<!-- settings: yaml -->

| Key | Level | Meaning | Default | Values | Who | Read at |
|---|---|---|---|---|---|---|
| `plan-only` | a model (or `defaults:`) | plan placement and check host memory and pins, print both, and stop before allocating any pool or reading a weight; the start exits 0 when admitted, 1 when refused | false | true \| false (a switch) | developer | `core/config.cpp:171` |
| `kld-record` | a model (or `defaults:`) | instead of serving, run kld-corpus through prefill and write this model's log-probabilities at every scored position to DIR: the reference a quantised model is measured against | none | folder | developer | `core/config.cpp:455` |
| `kld-ref` | a model (or `defaults:`) | instead of serving, score this model against the reference in DIR: mean, median, 99/99.9/99.99th percentile KL divergence and top-1 agreement, over the positions and tokens DIR was recorded at | none | folder | developer | `core/config.cpp:458` |
| `kld-corpus` | a model (or `defaults:`) | JSONL, one {"prompt", "score_from"?, "source"?} a line; kld-record only | none | file | developer | `core/config.cpp:461` |
| `calib-corpus` | a model (or `defaults:`) | instead of serving, run a JSONL corpus ({"prompt"} a line) through prefill once, every token, and record the calibration statistics the model keeps (each linear's input Gram, GPTQ's Hessian) | none | file | developer | `core/config.cpp:462` |
| `calib-dir` | a model (or `defaults:`) | where calib-corpus writes the statistics; beside kld-record, the reference's run records them over the KL corpus too | none | folder | developer | `core/config.cpp:465` |
| `calib-layers` | a model (or `defaults:`) | LO:HI, record layers LO..HI-1 only (default every layer), for a model whose statistics do not fit in memory in one run | every layer | LO:HI | developer | `core/config.cpp:467` |
| `kld-top` | a model (or `defaults:`) | kld-record keeps each position's N most likely tokens exactly and the mass of the rest, not the whole vocabulary (a corpus too large for full rows); 0 (default) keeps the whole vocabulary | 0 | whole number | developer | `core/config.cpp:469` |
| `kld-out` | a model (or `defaults:`) | the kld-ref report as JSON, and every position's numbers in FILE.rows | none | file | developer | `core/config.cpp:472` |
| `kld-lora` | a model (or `defaults:`) | run kld-record / kld-ref through the lora adapter NAME | none | name | developer | `core/config.cpp:473` |
| `kld-lora-sources` | a model (or `defaults:`) | kld-lora only for documents whose source starts with PREFIX; the rest run as the base, in the same steps (a mixed batch) | none | text | developer | `core/config.cpp:474` |
| `diagnose` | a model (or `defaults:`) | instead of serving, run a fixed workload on this engine and write diagnose.json and diagnose.md to DIR: decode by prompt category, a concurrency sweep, a prefill sweep with decode at each depth and a prompt arriving into running streams -- step times, tokens a step, draft acceptance, TTFT, emission intervals, jitter. Prompts are salted so the prefix cache serves none of them | none | folder | developer | `core/config.cpp:477` |
| `diagnose-tokens` | a model (or `defaults:`) | tokens a diagnose decode stream generates (default 256) | 256 | whole number | developer | `core/config.cpp:483` |
| `diagnose-runs` | a model (or `defaults:`) | measured runs of every diagnose point, after one unmeasured (default 3) | 3 | whole number | developer | `core/config.cpp:484` |
| `diagnose-concurrency` | a model (or `defaults:`) | stream counts of the concurrency sweep, comma-separated (default 1,2,4,8; counts above max-num-seqs are skipped and reported) | 1,2,4,8; counts above --max-num-seqs are skipped and reported | comma-separated list | developer | `core/config.cpp:485` |
| `diagnose-prefill` | a model (or `defaults:`) | prompt lengths of the prefill sweep in tokens, comma-separated (default 1024,4096,16384,65536; lengths the context cannot hold are skipped and reported) | 1024,4096,16384,65536; lengths the context cannot hold are skipped and reported | comma-separated list | developer | `core/config.cpp:487` |
| `diagnose-corpus` | a model (or `defaults:`) | JSONL of category prompts, one {"category", "messages" or "prompt", "max_tokens"?} a line; default: a built-in set of code, reasoning, prose, json, file_edit and summarization prompts | a built-in set of code, reasoning, prose, json, file_edit and summarization prompts | file | developer | `core/config.cpp:490` |
| `diagnose-baseline` | a model (or `defaults:`) | an earlier diagnose.json of the same workload: compare every request's tokens with it and fail the run on any difference (parity) | none | file | developer | `core/config.cpp:493` |
| `debug-graph` | a model (or `defaults:`) | print the entire declared graph and exit-quality detail | false | true \| false (a switch) | developer | `core/config.cpp:496` |
| `debug-selection` | a model (or `defaults:`) | print the selection table | false | true \| false (a switch) | developer | `core/config.cpp:497` |
| `debug-placement` | a model (or `defaults:`) | print the placement plan | false | true \| false (a switch) | developer | `core/config.cpp:498` |
| `debug-draft-oracle` | a model (or `defaults:`) | a verify-path test, not a drafter: with spec-ngram, prompt lookup proposes from the token ids in FILE (a plain greedy run's continuation of the one prompt the test sends), 30% of the drafts corrupted; the text must stay the plain run's | none | file | developer | `core/config.cpp:499` |
| `debug-accept-reference-kernels` | `server:` | serve even when ops resolve only to a reference library. NOT a production configuration: the reference implementation is an oracle and a last resort, and falling back to it is orders of magnitude of speed with nothing to say so. **Safety:** serves on slow reference kernels. Diagnostics only. | false | true \| false (a switch) | developer | `core/config.cpp:503` |
| `proceed-with-incompatible-configuration` | `server:` | start on a machine configuration radiance refuses (amdgpu CWSR off where cards serve). UNSUPPORTED: all guarantees are off, and the log and the startup report say so. **Safety:** starts a configuration the engine refuses as incompatible. Never for serving; diagnostics only. | false | true \| false (a switch) | developer | `core/config.cpp:507` |
| `profile-ops` | a model (or `defaults:`) | per-op device timing (see the caveat it prints) | false | true \| false (a switch) | developer | `core/config.cpp:511` |
| `expert-stats` | a model (or `defaults:`) | count the routed experts every layer selects, apart for prefill, decode, mixed steps and draft-head passes, and write the counts to FILE as JSON every 30 s and at shutdown. From the routing histograms the core already copies back: no device work, no synchronisation | none | file | developer | `core/config.cpp:512` |

## Environment variables

Every variable the code reads: radiance and its plugins, the kernel libraries and their selftests, the
tools, the Windows scripts, the build files, and Brilliance's own test switches. Set one for a single start with
`serve.ps1 -Env NAME=VALUE`, or in a profile with a `# brilliance-env: NAME=VALUE` line. Either takes only
`GPU_*`, `HIP_*`, `AMD_*`, `BRILLIANCE_*` and `RADIANCE_*` names. A switch read by "the `env_on` rule" is
off when unset, empty, `0`, `off`, `false` or `no`, and on for anything else.

### Set by `serve.ps1` (the launcher's overrides)

`serve.ps1` sets these for radiance from its parameters; radiance's YAML reader applies them over the profile at the start and at every reload, and the startup report names them as the source. Set them yourself only when you start `radiance.exe` without `serve.ps1`.

<!-- settings: env -->

| Variable | Meaning | Default | Values | Who | Read at |
|---|---|---|---|---|---|
| `BRILLIANCE_SERVER_HOST` | the listen address, over `server.host` (`serve.ps1 -Listen`) | unset: the profile's | IP address | launcher | `core/fleet/config.cpp:416` |
| `BRILLIANCE_SERVER_PORT` | the listen port, over `server.port` (`serve.ps1 -Port`) | unset: the profile's | 1-65535 | launcher | `core/fleet/config.cpp:418` |
| `BRILLIANCE_SERVER_API_KEY` | the key policy, over `server.api-key`/`api-key-env` (`serve.ps1 -ApiKey`): `off` serves without a key; `env:NAME` reads the key from variable NAME. **Safety:** a key itself is refused, so it never sits in the environment block of a service. | unset: the profile's | `off` \| `env:NAME` | launcher | `core/fleet/config.cpp:422` |
| `BRILLIANCE_SERVER_KERNELS` | the kernel libraries, over `server.kernels` (`serve.ps1 -Cpu` sets `libavx,libref`) | unset: the profile's | comma-separated library names | launcher | `core/fleet/config.cpp:420` |
| `BRILLIANCE_MODEL_PATH` | a model file or folder served in place of one model's `model:` (`serve.ps1 -Model`, `-Fetch`); the profile is not edited | unset | path | launcher | `core/fleet/config.cpp:452` |
| `BRILLIANCE_MODEL_NAME` | which model `BRILLIANCE_MODEL_PATH` replaces when the profile has several (`serve.ps1 -ModelName`); set without `BRILLIANCE_MODEL_PATH` it is refused | unset (the profile's only model) | a name under `models:` | launcher | `core/fleet/config.cpp:453` |
| `BRILLIANCE_MODEL_SPECULATION` | `off` sets every model's `num-speculative-tokens` to 0 and drops `spec-ngram` (`serve.ps1 -Cpu`) | unset | `off` | launcher | `core/fleet/config.cpp:447` |
| `BRILLIANCE_DEVICE` | `host` serves on the CPU: every card is hidden from HIP and no GPU is touched (`serve.ps1 -Cpu`). Anything else stops startup. | unset (the GPUs) | `host` | launcher | `core/main.cpp:73` |

### Models and downloads

Where models are fetched to and how.

<!-- settings: env -->

| Variable | Meaning | Default | Values | Who | Read at |
|---|---|---|---|---|---|
| `BRILLIANCE_HF_CACHE` | the model store: where a Hugging Face repo id (`model: owner/name`, `serve.ps1 -Fetch`, `hfget.ps1`) is fetched to, as `<store>\<owner>\<repo>`. `download-dir:` under `server:` and `serve.ps1 -ModelDir` take precedence. | unset: `XDG_CACHE_HOME\radiance\hf`, else `%LOCALAPPDATA%\radiance\hf` | folder | user | `core/hf_model.cpp:122` |
| `XDG_CACHE_HOME` | the cache root used when `BRILLIANCE_HF_CACHE` is unset (`<it>\radiance\hf`) | unset | folder | user | `core/hf_model.cpp:123` |
| `LOCALAPPDATA` | Windows' per-user data folder; the last fallback for the model store (`%LOCALAPPDATA%\radiance\hf`) | set by Windows | folder | system | `win/serve.ps1:764` |
| `HOME` | the cache root's last fallback on Linux (`~/.cache/radiance/hf`); not reached on Windows | set by the OS | folder | system | `core/hf_model.cpp:129` |
| `HF_TOKEN` | a Hugging Face token for a gated or private repo. **Safety:** a secret: `hfget.ps1` hands it to curl on stdin, never on a command line; `serve.ps1 -Env` refuses names that look like secrets. | unset (public repos only) | token | user | `win/libexec/hfget.ps1:114` |
| `HF_ENDPOINT` | the hub to fetch from, for a mirror | `https://huggingface.co` | URL | operator | `win/libexec/hfget.ps1:111` |
| `HFGET_JOBS` | parallel file transfers in `hfget.ps1` | 4 | 1-16 | operator | `win/libexec/hfget.ps1:106` |

### Behaviour switches for users and operators

Each one is read once at startup. Put one in a profile with a `# brilliance-env:` line, or give it for one start with `serve.ps1 -Env NAME=VALUE`.

<!-- settings: env -->

| Variable | Meaning | Default | Values | Who | Read at |
|---|---|---|---|---|---|
| `BRILLIANCE_TP2_PIPELINE` | `1` turns on the faster prefill for long prompts on two cards (Flash-Next): a long prompt prefilled alone sends each layer's exchange in pieces beside the next piece's compute. Needs a confirmed host link and an isolated wide span; otherwise it says why and stays off. | unset (off) | `1` | user | `arch/qwen4exp_fp8/qwen4exp_fp8.cpp:851` |
| `BRILLIANCE_EXACT_VERIFY` | `1` makes speculative decoding verify the 5-bit row-scaled IQR layers exactly, so a drafted run matches plain decoding there; costs DFlash2 decode speed (SUPPORT known issue 5). | unset (off) | `1`/`on`/`true`/`yes`; `0`/`off`/`false`/`no`; anything else is off with a warning | operator | `libr4d/r4d_rows.cpp:10932` |
| `BRILLIANCE_SDMA` | `1` keeps the HIP runtime's SDMA copy engines (radiance otherwise sets `PAL_DISABLE_SDMA=1`). With them on, small copies run as kernels (`BRILLIANCE_COPY_KERNELS`). The `flashnext-2card-fast` profile sets it. | off | `1`/`on` (the `env_on` rule: empty, `0`, `off`, `false`, `no` are off) | operator | `win/device/hipnative.cpp:157` |
| `BRILLIANCE_COPY_KERNELS` | how the engine's small copies and the step batch's uploads run: `auto` follows the copy engines (kernels when SDMA is on), `on` always as kernels, `off` never (the runtime's copies only, for an A/B) | auto | `auto` \| `on`/`1` \| `off`/`0` | developer | `win/device/hipnative.cpp:1912` |
| `BRILLIANCE_VMM` | HIP virtual memory for the pools (elastic memory, parking): on with one visible card, off with more. `0` turns it off; `1` forces it on, which is not qualified with several cards. | auto | `auto` \| `1` \| `0` (the `env_on` rule) | operator | `win/device/hipnative.cpp:2293` |
| `BRILLIANCE_PRIORITY` | the server process's Windows priority class. Never realtime. | above (Above Normal) | `high` \| `above` \| `normal`; anything else is `above` with a warning | operator | `win/os/os_win32.cpp:1446` |
| `BRILLIANCE_CPUS` | the logical processors the process runs on: `l3:N` (the Nth L3 domain), `vcache` (the domain with the largest L3), or a list such as `0-7,16-23` | unset (every processor) | `l3:N` \| `vcache` \| a CPU list | operator | `win/os/os_win32.cpp:1382` |
| `BRILLIANCE_H264_ENCODER` | the H.264 encoders video generation may use, in order. Only AMD's and Microsoft's are allowed. | `h264_amf,h264_mf` | comma-separated subset of `h264_amf`, `h264_mf` | operator | `core/mm/mp4.cpp:41` |
| `BRILLIANCE_PIN_LIMIT_GIB` | lowers the per-card limit on pinned host memory, in GiB. The limit is computed from the Windows shared-memory budget (budget / cards - 2 GiB); a value above it is capped with a warning, an invalid one ignored. **Safety:** never raise it, or test where the limit is, without the explicit approval of the machine's owner; pinned memory past the budget pages and can hang the machine. | the computed limit | whole GiB above 0 | operator | `win/device/hipnative.cpp:457` |
| `BRILLIANCE_PINNED_COHERENT` | `0` allocates pinned host memory non-coherent instead of coherent (the mailbox's own choice is `BRILLIANCE_MAILBOX_MEM`) | on (coherent) | the `env_on` rule | developer | `win/device/hipnative.cpp:534` |
| `BRILLIANCE_EVENT_SPIN` | `1` makes host waits on events spin instead of blocking (`hipEventBlockingSync` off) | off | the `env_on` rule | developer | `win/device/hipnative.cpp:1763` |
| `OMP_NUM_THREADS` | OpenMP's thread count. When set, the CPU kernels (libavx) take it instead of the physical cores in the process's affinity. | unset (the physical cores) | whole number | operator | `libavx/avx_common.h:98` |

### Two- and four-card collectives: workarounds and diagnostics

For the host-memory collectives of tensor-parallel runs (SUPPORT known issue 1). The defaults are the tested ones; change them only to diagnose.

<!-- settings: env -->

| Variable | Meaning | Default | Values | Who | Read at |
|---|---|---|---|---|---|
| `BRILLIANCE_MAILBOX_MEM` | the memory type of the two- and four-rank host mailboxes. Unset, every one takes `noncoherent-slots` (data slots non-coherent, flags coherent); at four ranks any value but `noncoherent-slots` keeps coherent slots. | unset (`noncoherent-slots`) | `default` \| `coherent` \| `wc` \| `noncoherent` \| `uncached` \| `noncoherent-slots`; a bad value is warned and ignored | developer | `libr4d/r4d_ar_entry.hip:408` |
| `BRILLIANCE_AR_RESEND` | `0` turns off the re-send of a lost host-collective write; only the stop (status 70) is left. **Safety:** with it off a lost write stops the server instead of recovering. | on | `0`/`off` (off); anything else on | developer | `libr4d/r4d_ar_entry.hip:3461` |
| `BRILLIANCE_AR_RESEND_MAX` | re-send requests for one block of one launch before the collective gives up | 8 (the kernel's) | 1-64 | developer | `libr4d/r4d_ar_entry.hip:974` |
| `BRILLIANCE_AR4_SHARD_WEIGHTS` | how four cards share the reduce work of each large exchange (the two-shot, plain and coded) when their PCIe links differ. `auto` times a 32 MiB copy each way over each card's link at load (under 0.1 s a card) and gives the reduce work to the cards on the fastest links, in equal shares; the others reduce nothing and carry each message once each way instead of 1.5 times. With two cards at Gen5 x8 and two on x4 risers, the x8 pair reduces everything (`0,1,1,0` with the risers as ranks 0 and 3): on the test machine both risers cost a prefill step about the same, one at Gen5 x4 and one at Gen4 x4, so neither gets a share. Links within 25% of the fastest count as fast; four fast links, or only one, keep even shares. `off` keeps even shares, the behaviour before this setting. The output is the same bits under every table. The startup log's `four-rank two-shot` line gives the table, each rank's bus and, under `auto`, the measured rates. A table that does not fit a message's slot runs that message even. Not reached: the coded form under `BRILLIANCE_AR_RESEND=0`, and decode-sized messages (`BRILLIANCE_AR4_MIN_ELEMS`). | `auto` | `auto` \| `off`/`even` \| four weights in rank order (`1,1,1,0`) \| `bus:weight` for every card (`3:1,9:1,6:1,32:0`); anything else stops the load by name | operator | `libr4d/r4d_ar_entry.hip:631` |
| `BRILLIANCE_AR4_MIN_ELEMS` | four-card messages under this many elements keep even shares whatever `BRILLIANCE_AR4_SHARD_WEIGHTS` says | 262144 (above every decode and verify message) | whole number; anything else stops the load by name | developer | `libr4d/r4d_ar_entry.hip:635` |
| `BRILLIANCE_STAGE_MIN_TOKENS` | arms the expert stager for prompt steps of N tokens and up, so pooled experts are copied onto the card instead of read across the link (a TP2 hang workaround, SUPPORT known issue 1) | unset (nothing changes) | 1 up to the arming size | developer | `core/engine_bringup.cpp:5543` |
| `BRILLIANCE_PUSH_PACE` | submits around the two-rank host push on steps under 1,024 tokens: N device launches after it each submitted on their own; a trailing `g` (`64g`) treats the gather push the same (a TP2 hang stopgap under test) | unset (off) | 1-4096, optional `g` | developer | `core/runtime/issue.cpp:327` |
| `BRILLIANCE_PUSH_SHADOW` | with the stall diagnostics on: a shadow of every pushed word (`full`) or a 32-bit hash per word (`hash`) | off | `full` \| `hash` | developer | `libr4d/r4d_ar_entry.hip:91` |
| `BRILLIANCE_AR_INJECT` | fault injection into the host collectives: `<op>:<mode>:<every>[:<rank>]` (op hc, ghc, exact, gather, wht6, hc6, ghc6; mode lose, dup, stuck, noflag, ctl-flag, pair, late, ctl-ack, ctl-rq). Logged as a W line. **Safety:** an S (stress) run only, never on a server people use; a `stuck` mode can stop the server. | unset (off) | the spec above; `0`/`off` off | developer | `libr4d/r4d_ar_entry.hip:3365` |
| `BRILLIANCE_TEST_COLL_FAULT` | the fault poll's test stand-in: `N` or `N:late` raises a collective fault at step N. Host backend only; ignored with a warning on a card. | unset | `N` \| `N:late` | developer | `core/engine.cpp:1510` |
| `BRILLIANCE_SLOG_LAUNCHES` | `1` logs every launch by name with a completion mark behind it (the stall diagnostics). It also changes submission (every launch submitted on its own), which suppresses the TP2 hang; slower. | off | not `0` | developer | `libr4d/r4d_ar_entry.hip:1167` |
| `BRILLIANCE_SLOG_MARK` | with `BRILLIANCE_SLOG_LAUNCHES`: how a launch's completion is marked: `event`, `write` (a stream write of a serial into pinned memory), or `off` (names only) | event | `event`/`1` \| `write` \| anything else is off | developer | `win/device/hipnative.cpp:1380` |
| `BRILLIANCE_STOP_LOG` | the stop journal: a file, or an existing folder (then `radiance-stop-<pid>.log` in it). Each stop step is written through to disk before the stop goes on, so after a hard lock the file shows the last finished step; nothing is written while the server serves. Check a journal with `win/tools/stop_log_check.py`. See SUPPORT.md, "Stopping a multi-card server". | unset (off) | a file or folder path | operator | `core/util/stoplog.cpp:237` |
| `BRILLIANCE_STALL_CAPTURE` | `1` records each launch so that the stall watch can capture the device state when a stall is seen | off | the `env_on` rule | developer | `libr4d/r4d_ar_entry.hip:1180` |
| `BRILLIANCE_STALL_BEACONS` | the stall watch's progress beacons: one behind every Nth op on a stream. `0` turns them off, and then a step that keeps a card busy past 5 s reads as a stall. | 64 | 0-1000000 | developer | `win/device/hipnative.cpp:1009` |
| `R4D_AR_MAX_BLOCKS` | caps the blocks one all-reduce launch uses in libr4d (two engines on shared cards) | unset (the library's own) | whole number below the design count | developer | `libr4d/r4d_ar_entry.hip:847` |

### Memory and loading diagnostics

<!-- settings: env -->

| Variable | Meaning | Default | Values | Who | Read at |
|---|---|---|---|---|---|
| `BRILLIANCE_NGRAM_WARM_IO` | how `ngram-warm` reads the table, for a measurement: `io=pread\|handle\|prefetch,readers=N,piece=SIZE` (any subset) | the built-in reader | readers 1-64; piece 1 MiB-1 GiB (K, M, G suffixes); a bad value is warned and ignored | developer | `core/engine_bringup.cpp:4596` |
| `BRILLIANCE_DEBUG_WEIGHTS_MIB` | lowers every rank's VRAM weights pool to N MiB, so experts spill to the host pool and file tier (a test knob, warned) | unset | MiB above 0 | developer | `core/engine_bringup.cpp:2463` |
| `RADIANCE_DEBUG_LOAD_EVERY_MIB` | a load progress note every N MiB read | 8192 (8 GiB) | MiB above 0 | developer | `core/engine_bringup.cpp:3793` |
| `RADIANCE_TRACE_ALLOC` | logs every device allocation of at least N bytes | unset (off) | bytes, 0 and up | developer | `core/device/dispatch.cpp:227` |
| `RADIANCE_DEBUG_POISON_ALLOC` | fills every new device allocation with this byte, to find reads of unwritten memory | unset (off) | 0-255 | developer | `core/device/dispatch.cpp:238` |
| `RADIANCE_DEBUG_POISON_RANGE` | with `RADIANCE_DEBUG_POISON_ALLOC`: only the allocations with ordinals in [lo, hi) | the whole run | `lo:hi`, 0 <= lo < hi (else the process aborts) | developer | `core/device/dispatch.cpp:254` |

### HIP runtime (read by AMD's runtime)

radiance sets the first five before the runtime starts, only where they are unset, so a value you set wins. It logs the others as it finds them (`device: HIP runtime settings in this process`).

<!-- settings: env -->

| Variable | Meaning | Default | Values | Who | Read at |
|---|---|---|---|---|---|
| `GPU_MAX_ALLOC_PERCENT` | the share of a card one allocation may take; radiance's pools are single large allocations | 100 (set by radiance) | percent | developer | `win/device/hipnative.cpp:148` |
| `GPU_SINGLE_ALLOC_PERCENT` | as above, for a single allocation | 100 (set by radiance) | percent | developer | `win/device/hipnative.cpp:149` |
| `GPU_MAX_HEAP_SIZE` | the heap share of a card | 100 (set by radiance) | percent | developer | `win/device/hipnative.cpp:150` |
| `PAL_DISABLE_SDMA` | `1` turns off the SDMA copy engines (a gfx1201 copy-ordering bug, rocm-systems#12571). `BRILLIANCE_SDMA=1` keeps them. | 1 (set by radiance unless `BRILLIANCE_SDMA` is on) | `0` \| `1` | developer | `win/device/hipnative.cpp:157` |
| `GPU_RESOURCE_CACHE_SIZE` | PAL's cache of freed allocations; radiance turns it off so freed VRAM is free at once (reload, park) | 0 (set by radiance) | bytes | developer | `win/device/hipnative.cpp:183` |
| `GPU_MAX_HW_QUEUES` | hardware queues per card. The selftests raise it to 16 for eight ranks on one card. | the runtime's | whole number | developer | `libr4d/r4d_selftest.cpp:37966` |
| `GPU_FLUSH_ON_EXECUTION` | the runtime submits after every launch; logged only | the runtime's | `0` \| `1` | developer | `win/device/hipnative.cpp:189` |
| `AMD_OPT_FLUSH` | a runtime flush mode; logged only | the runtime's | the runtime's | developer | `win/device/hipnative.cpp:189` |
| `AMD_SERIALIZE_KERNEL` | the runtime serialises kernels; logged only | the runtime's | the runtime's | developer | `win/device/hipnative.cpp:189` |
| `AMD_SERIALIZE_COPY` | the runtime serialises copies; logged only | the runtime's | the runtime's | developer | `win/device/hipnative.cpp:190` |
| `AMD_DIRECT_DISPATCH` | the runtime's direct dispatch; logged only | the runtime's | the runtime's | developer | `win/device/hipnative.cpp:190` |
| `HIP_VISIBLE_DEVICES` | the cards HIP shows the process, by HIP index. **Safety:** choose cards with `serve.ps1 -Bus` (by PCI bus) instead; HIP's numbering changes across boots, and `serve.ps1 -Env` refuses this name. radiance sets `-1` itself for `BRILLIANCE_DEVICE=host`. | unset: `serve.ps1` sets every discrete card | HIP indices, comma-separated; `-1` none | operator | `core/main.cpp:79` |
| `ROCR_VISIBLE_DEVICES` | ROCm's device mask on Linux; named in the diagnostics report only | unset | the runtime's | developer | `core/diag/diagnose.cpp:1044` |
| `CUDA_VISIBLE_DEVICES` | the selftest's fallback when `HIP_VISIBLE_DEVICES` is unset | unset | indices | developer | `libr4d/r4d_selftest.cpp:37638` |

### Radiance engine (from upstream)

<!-- settings: env -->

| Variable | Meaning | Default | Values | Who | Read at |
|---|---|---|---|---|---|
| `RADIANCE_HOME` | the plugin home (kernels, architectures, quantizers) when `radiance-home:` is not set | the home beside the executable: `share\radiance` in a package, `radiance_home` in a build tree | folder | developer | `core/config.cpp:1521` |
| `RADIANCE_KERNELS` | the kernel libraries to load when `kernels:` is not set, first wins | every library found | names separated by `,` or `:` | developer | `core/config.cpp:1534` |
| `RADIANCE_LOG` | the starting log level; the YAML's `server.log` takes over once the file is read | info | `error` \| `warn` \| `info` \| `debug` \| `trace` | operator | `core/util/rad_util.cpp:27` |
| `RADIANCE_LOG_STEPS` | one log line per step: its phase and each sequence's slot, query length and context | off | set (any value) | developer | `core/engine.cpp:1686` |
| `RADIANCE_PROFILE_EVERY` | with `profile-ops`: profile one step in N | 32 | whole number above 0 | developer | `core/engine.cpp:1841` |
| `RADIANCE_TUNE` | pins kernel tuning axes without a rebuild: `op:key=value[,key=value][;op:...]`. An axis a kernel does not offer stops startup. | unset | the spec above | developer | `core/plugin/select.cpp:352` |
| `RADIANCE_HOST_DEVICES` | fakes N devices on the host backend, to test tensor parallel without cards | 1 | 1 up to the fake-device limit | developer | `core/device/host.cpp:296` |
| `RADIANCE_HOST_VRAM_MIB` | the host backend's fake per-device VRAM | half of RAM, split over the fake devices | MiB | developer | `core/device/host.cpp:320` |
| `RADIANCE_EXPERT_SPLIT` | routed experts per rank, comma-separated, summing to the model's: an uneven split. A list that does not fit the model is refused. | an even split | comma-separated counts | developer | `arch/common/rad_expert_split.h:27` |
| `RADIANCE_DS41_EXPERT_SPLIT` | DeepSeek 4.1's own older name for `RADIANCE_EXPERT_SPLIT` (each count even), read when that is unset | an even split | comma-separated even counts | developer | `arch/deepseek41/deepseek41.cpp:701` |
| `RADIANCE_MEDIA_OUT` | folder where finished generated images (`images/`) and videos (`videos/`) are saved with a shared zero-padded index (`.index`) | unset (disabled) | folder path | operator | `core/engine.cpp:4038` |
| `RADIANCE_HISTORY_DIR` | folder where finished request logs (`<model>.jsonl`) and fleet off-switch state (`fleet-off.json`) are kept across restarts | unset (in-memory only) | folder path | operator | `core/fleet/fleet.cpp:3122` |
| `RADIANCE_DASHBOARD_PAGE` | built HTML file (`dist/index.html`) served in place of the compiled-in dashboard page, re-read on each load | unset (compiled-in page) | file path | operator | `core/server/dashboard.cpp:689` |

### Calibration (for converting models)

<!-- settings: env -->

| Variable | Meaning | Default | Values | Who | Read at |
|---|---|---|---|---|---|
| `RADIANCE_CALIB_DIR` | turns on the calibration tap: activation statistics are written to this folder | unset (off) | folder | developer | `arch/common/rad_arch.h:126` |
| `RADIANCE_CALIB_LAYERS` | the layers the tap records: comma-separated layers and `lo-hi` ranges, for a model calibrated in several runs | every layer | list of layers and ranges | developer | `arch/common/rad_arch.h:137` |
| `RADIANCE_CALIB_TOKENS` | the token count at which the tap writes and switches itself off | 65536 | whole number | developer | `arch/common/rad_arch.h:164` |
| `RADIANCE_G3_CALIB_LAYERS` | Gemma 3's calibration slice | every layer | `lo:hi` | developer | `arch/gemma3/gemma3.cpp:1443` |
| `RADIANCE_G4_CALIB_LAYERS` | Gemma 4's calibration slice | every layer | `lo:hi` | developer | `arch/gemma4/gemma4.cpp:1338` |
| `RADIANCE_SPARK_CALIB_LAYERS` | Spark 2.5's calibration slice | every layer | `lo:hi` | developer | `arch/spark25_bf16/spark25_bf16.cpp:215` |
| `RAD_LQ_LAPACK` | `0` makes the GPTQ quantiser use its loops instead of LAPACK (the reference path) | on where OpenBLAS was found | `0` | developer | `libquant/lq_gptq.cpp:131` |

### Engine debugging (developer only)

Each slows the engine or writes large files. Never on a server people use.

<!-- settings: env -->

| Variable | Meaning | Default | Values | Who | Read at |
|---|---|---|---|---|---|
| `RADIANCE_DEBUG_CKPT_HASH` | `1` hashes each rank's checkpoint snapshots, to compare builds; drains the streams | off | `1` | developer | `core/engine.cpp:2311` |
| `RADIANCE_DEBUG_CONC_LOG` | writes the adaptive draft depth's online log to this file | unset | file | developer | `core/engine_draft.cpp:211` |
| `RADIANCE_DEBUG_DS41_DUMP` | writes DeepSeek-V4.1's per-layer trace of every prefill step into this folder: each layer's input streams, each rank's attention partial and the reduced output, the MoE input, the router scores, the selected experts and their weights, the MoE output, then the final rows and each rank's head logits (`s<step>.t<rows>.l<layer>.<site>.r<rank>.<dtype>`). Synchronises the stream at every site; a recorded (replayed) pass writes nothing. **Safety:** diagnostics only; slow, and the folder grows by about 2 MB a layer a rank for a 30-row step. | unset (off) | folder | developer | `arch/deepseek41/deepseek41.cpp:1490` |
| `RADIANCE_DEBUG_DRAFT` | counts why draft rounds were or were not scheduled | off | not `0` | developer | `core/sched/scheduler.cpp:4306` |
| `RADIANCE_DEBUG_ISSUE` | times weight-table refreshes in the issue path | off | set | developer | `core/runtime/issue.cpp:343` |
| `RADIANCE_DEBUG_JINJA` | traces every statement of every chat-template render (very verbose) | off | not `0` | developer | `core/text/chat.cpp:63` |
| `RADIANCE_DEBUG_MM_DUMP` | writes each image's patches and encoder rows as raw bf16 into this folder | unset | folder | developer | `core/engine_mm.cpp:37` |
| `RADIANCE_DEBUG_MM_BUFFERS` | with `RADIANCE_DEBUG_MM_DUMP`: also these named encoder buffers | unset | comma-separated names | developer | `core/engine_mm.cpp:59` |
| `RADIANCE_DEBUG_NEMOTRONH_DUMP` | writes Nemotron-H's per-layer hidden states into this folder | unset | folder | developer | `arch/nemotronh/nemotronh.cpp:1086` |
| `RADIANCE_LING_DUMP` | writes the Ling (bailing hybrid) model's per-layer states into this folder | unset | folder | developer | `arch/bailing_hybrid/bailing_hybrid.cpp:1054` |
| `RADIANCE_DEBUG_QSA` | prints the first few sparse-attention selections; synchronises the stream | off | set | developer | `arch/common/rad_qsa.h:491` |
| `RADIANCE_DEBUG_QSA_EAGER` | the eager sparse-attention sequence, to compare with the fused forms | off | set | developer | `arch/common/rad_arch.h:1550` |
| `RADIANCE_DEBUG_RESID` | prints the residual stream's statistics (rms, median, max) at each layer and site, once | off | set | developer | `arch/common/rad_arch.h:87` |
| `RADIANCE_DEBUG_ROUTING` | dumps MoE routing for this layer on the first steps | unset | layer number | developer | `core/runtime/ctx.cpp:758` |
| `RADIANCE_DEBUG_STAGE` | running means of a draft pass's host time | off | set | developer | `core/engine_draft.cpp:653` |
| `RADIANCE_DEBUG_TIER_VERIFY` | verifies the tier executor's replicated copies (a debugging check) | off | set | developer | `core/runtime/tierexec.cpp:87` |
| `RADIANCE_DFLASH_TRACE` | logs each DFlash drafter pass's kind, positions and token ids | off | set | developer | `core/sched/batch.cpp:1173` |
| `RADIANCE_DUMP_BUF` | at trace log level: these named buffers after each step | unset | comma-separated names | developer | `core/engine_probe.cpp:171` |
| `RADIANCE_DUMP_BYTES` | bytes of a row the dump reads back | 8192 | whole number | developer | `core/engine_probe.cpp:44` |
| `RADIANCE_DUMP_DIR` | also writes each dumped buffer to this folder | unset | folder | developer | `core/engine_probe.cpp:77` |
| `RADIANCE_DUMP_HEAD` | the dump prints the first N logits | 0 | 0-4096 | developer | `core/engine_probe.cpp:99` |
| `RADIANCE_DUMP_TOPK` | the dump prints the top K logits | 0 | 0-64 | developer | `core/engine_probe.cpp:124` |
| `RADIANCE_OP_ORACLE` | runs the named ops' reference kernels beside the device kernels and compares (the op oracle) | unset (off) | comma-separated op names | developer | `core/runtime/oracle.cpp:168` |
| `RADIANCE_OP_ORACLE_FROM` | the first issue the oracle checks | 0 | whole number | developer | `core/runtime/oracle.cpp:186` |
| `RADIANCE_OP_ORACLE_TO` | the issue the oracle stops before | no end | whole number | developer | `core/runtime/oracle.cpp:187` |
| `RADIANCE_OP_ORACLE_MAX` | the most checks the oracle makes | 32 | whole number | developer | `core/runtime/oracle.cpp:183` |
| `RADIANCE_OP_ORACLE_MAXBYTES` | the largest operand the oracle copies | 4 GiB | bytes | developer | `core/runtime/oracle.cpp:185` |
| `RADIANCE_OP_ORACLE_TOL` | the oracle's tolerance | the oracle's own | number | developer | `core/runtime/oracle.cpp:188` |
| `RADIANCE_OP_REPEAT` | runs each named op's device kernel twice on the same bytes and compares: a determinism check. Overrides `RADIANCE_OP_ORACLE`. | unset (off) | comma-separated op names | developer | `core/runtime/oracle.cpp:166` |
| `RADIANCE_OP_REPEAT_FROM` | the first issue the repeat check runs | 0 | whole number | developer | `core/runtime/oracle.cpp:186` |
| `RADIANCE_OP_REPEAT_TO` | the issue the repeat check stops before | no end | whole number | developer | `core/runtime/oracle.cpp:187` |
| `RADIANCE_OP_REPEAT_MAX` | the most repeat checks | 1000000 | whole number | developer | `core/runtime/oracle.cpp:183` |
| `RADIANCE_OP_REPEAT_MAXBYTES` | the largest operand the repeat check copies | 8 MiB | bytes | developer | `core/runtime/oracle.cpp:184` |
| `RADIANCE_KV_STAGE_TRACE` | one line per pass that staged KV from host memory | off | set | developer | `core/kvstream/stage.cpp:30` |
| `RADIANCE_MLA_CONFLICT_STATS` | collects the MLA attention kernels' conflict statistics | off | not `0` | developer | `libr4d/r4d_mla.hip:946` |
| `RADIANCE_GDN_ANCHOR` | `1`: anchor state in the gated delta net's recurrent update, for the raw C entry vLLM calls; radiance itself declares the form as an op parameter, so it has no effect on radiance | off | `1` | developer | `libr4d/r4d_gdn_recurrent_update_k128_v128_bf16_fp32state.hip:820` |
| `RADIANCE_TEST_KV_ROLLBACK_REPORT` | a test: writes evidence of a KV rollback after a rejected draft to this file. Read only in a build with `RAD_ENABLE_KV_ROLLBACK_TEST_HOOK`, not a shipped one | unset | file | developer | `core/engine.cpp:196` |
| `RAD_E2E_STOP_RANK_GATE` | a test: with the stop journal on, the last rank waits after its first step release until this file exists (15 s at most), so a stop can begin between a release and that rank's wake-up. Read only in a host build with tests (`RAD_ENABLE_RANK_STOP_TEST_HOOK`), never a shipped one | unset | file | developer | `core/engine.cpp:1293` |
| `RADIANCE_AQL_STAMP` | times every dispatch of one pass in N on card 0. No effect in the Windows build: the AQL backend that reads it is Linux's. | 0 (off) | whole number | developer | `core/device/aql.cpp:2494` |
| `RADIANCE_AQL_STAMP_OUT` | where `RADIANCE_AQL_STAMP` writes. No effect in the Windows build: the AQL backend that reads it is Linux's. | `/tmp/radiance-stamps-<pid>.csv` | file | developer | `core/device/aql.cpp:2496` |
| `RADIANCE_AQL_CHAIN_FENCE` | `1` keeps the fence on chained dispatches. No effect in the Windows build: the AQL backend that reads it is Linux's. | off | `1` | developer | `core/device/aql.cpp:1310` |

### Kernel libraries and their selftests (developer only)

<!-- settings: env -->

| Variable | Meaning | Default | Values | Who | Read at |
|---|---|---|---|---|---|
| `R4D_GEMMCFG` | libr4d prints each distinct GEMM tuning resolution once | off | not `0` | developer | `libr4d/r4d_gemm_args.h:174` |
| `R4D_F8_MWLOG` | libr4d prints each distinct FP8 GEMM shape once | off | not `0` | developer | `libr4d/r4d_gemm_fp8a8.hip:968` |
| `RAD_R4D_TRACE` | libr4d says where it refuses an op (file:line) | off | not `0` | developer | `libr4d/r4d_args.h:194` |
| `R4D_SELFTEST_ONE_CARD` | `r4d_selftest` runs every rank on one card | off | not `0` | developer | `libr4d/r4d_selftest.cpp:540` |
| `R4D_PERF_POINTS` | `r4d_selftest`: points an interactive tuning sweep walks | 64 | whole number | developer | `libr4d/r4d_selftest.cpp:778` |
| `R4D_PERF_ONLY` | `r4d_selftest`: time this row alone | unset | row name | developer | `libr4d/r4d_selftest.cpp:17821` |
| `R4D_PERF_ARM` | `r4d_selftest`: pin the row's tile arm | unset | whole number | developer | `libr4d/r4d_selftest.cpp:6796` |
| `R4D_PERF_RAND_SCRATCH` | `r4d_selftest`: fill scratch with random bytes | off | set | developer | `libr4d/r4d_selftest.cpp:17843` |
| `R4D_PERF_ROUTE_FILE` | `r4d_selftest`: draw experts by a measured routing histogram (one weight a line) | uniform | file | developer | `libr4d/r4d_selftest.cpp:8263` |
| `R4D_PERF_IQR_B` | `r4d_selftest`: time only this IQR batch | 0 (all) | whole number | developer | `libr4d/r4d_selftest.cpp:8332` |
| `R4D_PERF_IQR_PROJ` | `r4d_selftest`: time only this IQR projection | -1 (all) | whole number | developer | `libr4d/r4d_selftest.cpp:8333` |
| `R4D_PERF_IQR_PINS` | `r4d_selftest`: the IQR prefill maps timed in turn | `4,0` | comma-separated values | developer | `libr4d/r4d_selftest.cpp:8338` |
| `R4D_PERF_IQR_ALIAS` | `r4d_selftest`: every IQR expert the same bytes (launch cost without weight traffic) | off | set | developer | `libr4d/r4d_selftest.cpp:8410` |
| `R4D_PERF_IQR_GAP_MS` | `r4d_selftest`: a pause between IQR launches, in ms | unset (back to back) | whole number | developer | `libr4d/r4d_selftest.cpp:8511` |
| `R4D_PERF_MOE_ONLY` | `r4d_selftest`: only the MoE rows of this name | unset | row name | developer | `libr4d/r4d_selftest.cpp:18733` |
| `R4D_PERF_MOE_MT` | `r4d_selftest`: the MoE down tile's M tiles a block | `2` | comma-separated 2, 4 | developer | `libr4d/r4d_selftest.cpp:18739` |
| `R4D_PERF_MOE_ALIAS` | `r4d_selftest`: `1` every expert the first one's bytes, `0` each its own | unset | `0` \| `1` | developer | `libr4d/r4d_selftest.cpp:18823` |
| `R4D_USEL_KIND` | `r4d_selftest --perfusel`: `2` rows of unrelated sequences | unset | `2` | developer | `libr4d/r4d_selftest.cpp:4635` |
| `R4D_USEL_SEL` | `r4d_selftest --perfusel`: a selection table file (with `R4D_USEL_SEQU`) | unset | file | developer | `libr4d/r4d_selftest.cpp:4611` |
| `R4D_USEL_SEQU` | `r4d_selftest --perfusel`: the sequence file that goes with `R4D_USEL_SEL` | unset | file | developer | `libr4d/r4d_selftest.cpp:4612` |
| `R4D_WFAULT_KEEP` | `r4d_selftest`: `1` keeps the four-rank fault record between launches | off | `1` | developer | `libr4d/r4d_selftest.cpp:31734` |
| `HALO_AR_MAX_BLOCKS` | caps the blocks one all-reduce launch uses. No effect in the Windows build: the libhalo library is built for other GPUs only (gfx11), not the R9700's gfx12. | unset | whole number | developer | `libhalo/halo_ar_entry.hip:310` |
| `HALO_GEMMCFG` | prints each distinct GEMM tuning resolution once. No effect in the Windows build: the libhalo library is built for other GPUs only (gfx11), not the R9700's gfx12. | off | not `0` | developer | `libhalo/halo_gemm_args.h:190` |
| `RAD_HALO_TRACE` | says where the library refuses an op. No effect in the Windows build: the libhalo/libr3d library is built for other GPUs only (gfx11), not the R9700's gfx12. | off | not `0` | developer | `libhalo/halo_args.h:198` |
| `HALO_AR_SHARED_MAX_KERNELS` | `halo_selftest`. No effect in the Windows build: the libhalo library is built for other GPUs only (gfx11), not the R9700's gfx12. | unset | whole number | developer | `libhalo/halo_selftest.cpp:31579` |
| `HALO_AR_SHARED_NBLOCKS` | `halo_selftest`. No effect in the Windows build: the libhalo library is built for other GPUs only (gfx11), not the R9700's gfx12. | unset | whole number | developer | `libhalo/halo_selftest.cpp:31642` |
| `HALO_PERF_ONLY` | `halo_selftest`: time this row alone. No effect in the Windows build: the libhalo library is built for other GPUs only (gfx11), not the R9700's gfx12. | unset | row name | developer | `libhalo/halo_selftest.cpp:19574` |
| `HALO_PERF_POINTS` | `halo_selftest`: sweep points. No effect in the Windows build: the libhalo library is built for other GPUs only (gfx11), not the R9700's gfx12. | 64 | whole number | developer | `libhalo/halo_selftest.cpp:878` |
| `HALO_SELFTEST_CHILD` | set by `halo_selftest` for its child processes. No effect in the Windows build: the libhalo library is built for other GPUs only (gfx11), not the R9700's gfx12. | unset | set | internal | `libhalo/halo_selftest.cpp:129` |
| `HALO_SELFTEST_ONE_CARD` | `halo_selftest` on one card. No effect in the Windows build: the libhalo library is built for other GPUs only (gfx11), not the R9700's gfx12. | off | not `0` | developer | `libhalo/halo_selftest.cpp:598` |
| `RAD_R3D_TRACE` | says where libr3d refuses an op. No effect in the Windows build: the libr3d library is built for other GPUs only (gfx11), not the R9700's gfx12. | off | not `0` | developer | `libr3d/r3d_args.h:190` |
| `RAD_R3D_DEV` | with `RAD_R3D_TRACE`: device prints, N of them. No effect in the Windows build: the libr3d library is built for other GPUs only (gfx11), not the R9700's gfx12. | the library's | whole number; 0 none | developer | `libr3d/r3d_attn_paged_h128.hip:1296` |
| `TMPDIR` | `avx_check` (libavx's checker) writes its gather case here | `/tmp` | folder | developer | `libavx/avx_check.cpp:826` |

### Building (`win\env.ps1` sets these)

`win\env.ps1` sets them from `.toolchain\toolchain.json`, which `win\setup.ps1` writes. Don't set them by hand.

<!-- settings: env -->

| Variable | Meaning | Default | Values | Who | Read at |
|---|---|---|---|---|---|
| `BRILLIANCE_GPU_TARGETS` | the GPU targets a HIP build compiles for (`RAD_GPU_TARGETS`) | the manifest's (`gfx1201`) | gfx names | build | `win/build.ps1:45` |
| `BRILLIANCE_FFMPEG_ROOT` | the FFmpeg build the configure links | the manifest's (`.toolchain\ffmpeg`) | folder | build | `win/cmake/RadWindows.cmake:188` |
| `BRILLIANCE_LIBOMP_DIR` | the folder holding `lib\libomp.lib` and `bin\libomp.dll` | the manifest's | folder | build | `win/cmake/RadWindowsPlugin.cmake:78` |
| `BRILLIANCE_VCVARS_DONE` | marks a shell where the pinned MSVC toolset's vcvars already ran | unset | the toolset version | build | `win/env.ps1:30` |
| `HIP_PATH` | the HIP SDK; `env.ps1` sets it per shell, and `setup.ps1` warns about a machine-wide one | set by `env.ps1` | folder | build | `win/setup.ps1:144` |
| `VCToolsInstallDir` | the MSVC toolset (from vcvars) | set by vcvars | folder | build | `win/env.ps1:37` |
| `VCToolsVersion` | the MSVC toolset version (from vcvars) | set by vcvars | version | build | `win/env.ps1:37` |
| `VCToolsRedistDir` | where `package.ps1` takes the VC++ runtime DLLs (from vcvars) | set by vcvars | folder | build | `win/package.ps1:121` |
| `VCINSTALLDIR` | Visual Studio's VC folder, where the plugin build looks for libomp (from vcvars) | set by vcvars | folder | build | `win/cmake/RadWindowsPlugin.cmake:80` |
| `VSINSTALLDIR` | Visual Studio's folder (from vcvars) | set by vcvars | folder | build | `win/cmake/RadWindowsPlugin.cmake:80` |
| `WindowsSDKVersion` | the Windows SDK version (from vcvars) | set by vcvars | version | build | `win/env.ps1:62` |
| `ProgramW6432` | the 64-bit Program Files folder: the default install prefix (`Program Files\Brilliance`) | set by Windows | folder | system | `win/cmake/RadWindows.cmake:24` |
| `ProgramFiles` | Program Files; `serve.ps1 -Install` notes a service run from outside it, and `build.ps1` finds tools there | set by Windows | folder | system | `win/serve.ps1:903` |
| `PATH` | the search path; `env.ps1` and `build.ps1` put the toolchain first, `serve.ps1` the HIP runtime | set by Windows | folders | system | `win/serve.ps1:506` |
| `COMPUTERNAME` | recorded in the toolchain manifest by `setup.ps1` | set by Windows | name | system | `win/setup.ps1:312` |

### rad-export

<!-- settings: env -->

| Variable | Meaning | Default | Values | Who | Read at |
|---|---|---|---|---|---|
| `RADIANCE_IMAGE` | the Radiance container image `rad-export` runs `rad-convert` in under Docker, when `--image` is not given | the config file's, else the built-in image | image name | developer | `tools/rad-export:78` |
| `UNSLOTH_POST_EXPORT` | set by Unsloth's export hook: `rad-export` then prints `UNSLOTH_HOOK_OUTPUT=<out>` | unset | set | internal | `tools/rad-export:652` |

### Tests (developer only)

Brilliance's own test switches. Upstream's unit-test harness reads dozens more (`RAD_TEST_*` and the like); they configure its tests, not the product, and are documented beside the tests.

<!-- settings: env -->

| Variable | Meaning | Default | Values | Who | Read at |
|---|---|---|---|---|---|
| `BRILLIANCE_DS41_HEADER` | `deepseek41_test`: the installed DeepSeek 4.1 model file whose header the test reads; unset, that case is skipped | unset (skipped) | path | developer | `tests/deepseek41_test.cpp:642` |
| `BRILLIANCE_DS41_HIP_ROWS` | `deepseek41_hip_test`: set when the single-card DeepSeek fixture is leased to the run; unset, the case is skipped | unset (skipped) | set | developer | `tests/deepseek41_hip_test.cpp:147` |
| `BRILLIANCE_KEEP_DS41_FIXTURE` | `deepseek41_test`: keep the temporary fixture folder after the run | unset (removed) | set | developer | `tests/deepseek41_test.cpp:368` |

### Windows and internal

Set by Windows or by the scripts themselves. Never set these.

<!-- settings: env -->

| Variable | Meaning | Default | Values | Who | Read at |
|---|---|---|---|---|---|
| `SystemRoot` | the Windows folder; the scripts run `System32` tools from it (sc.exe, icacls, curl, cmd) | set by Windows | folder | system | `win/serve.ps1:170` |
| `ProgramData` | `serve.ps1 -Install` keeps a service's YAML, logs and key files under `%ProgramData%\Brilliance` | set by Windows | folder | system | `win/serve.ps1:173` |
| `TEMP` | `reload-server.ps1` recognises an older `serve.ps1`'s temporary profile copy here | set by Windows | folder | system | `win/tools/reload-server.ps1:32` |
| `BRL_SERVE_HIP_BIN` | `serve.ps1`'s own: the HIP runtime folder its card probe puts on PATH | set by `serve.ps1` | folder | internal | `win/serve.ps1:506` |
| `BRL_SERVE_HIP_WHOLE` | `serve.ps1`'s own: the card probe asks about every card | set by `serve.ps1` | `1` | internal | `win/serve.ps1:505` |
| `BRILLIANCE_SERVE_TEST_DEVICES` | tests only: replaces `serve.ps1`'s card probe with a fixed table, so the tests touch no card | unset | `INDEX:BUS:INTEGRATED,...` \| `none` | developer | `win/serve.ps1:480` |

## Tools

### `radiance.exe`

radiance takes its settings from a YAML file. Any other flag is refused, and the refusal prints the same settings written as YAML. As a Windows service it is started by `serve.ps1 -Install`.

<!-- settings: radiance -->

| Setting | Meaning | Default | Values | Who | Read at |
|---|---|---|---|---|---|
| `--config` | the YAML file naming every model the process serves | required | path | user | `core/main.cpp:52` |
| `--check` | read and validate the file, print what it configures, serve nothing | off | flag | user | `core/main.cpp:50` |
| `--help`, `-h` | print the YAML key reference and exit |  | flag | user | `core/main.cpp:46` |
| `--plan-only` | accepted only to explain itself: with `--config`, radiance exits 2 and says to set `plan-only: true` in a copy of the model's YAML instead (see PREVIEW.md, DeepSeek two-card) | off | flag | user | `core/main.cpp:51` |
| `--service` | run as the Windows service of this name (written by `serve.ps1 -Install`) |  | service name, no `/` or `\` | operator | `win/os/service_win32.cpp:47` |
| `--log` | with `--service`: the log file | beside the YAML | path | operator | `win/os/service_win32.cpp:79` |
| `--env-from-file` | with `--service`: set variable VAR to the one line in FILE before the YAML is read (a key kept out of the registry). Repeatable. | none | `VAR=FILE` | operator | `win/os/service_win32.cpp:81` |
| `--stop-timeout` | with `--service`: seconds a stop's drain may take before it is reported | 180 | 1-86400 | operator | `win/os/service_win32.cpp:90` |

### `rad-convert.exe`: checkpoint in, `.rad` out

`rad-convert [options] <input> -o <model.rad>`. On Windows it runs on the host only: it uses no GPU.

<!-- settings: rad-convert -->

| Setting | Meaning | Default | Values | Who | Read at |
|---|---|---|---|---|---|
| `-o`, `--out` | the container to write | required | path | user | `tools/rad_convert.cpp:489` |
| `--recipe` | the quantisation recipe file: one rule a line, `PATTERN QUANTISER key=value ...`; `$NAME` in a value is the environment's | none (the checkpoint's encodings) | file | user | `tools/rad_convert.cpp:490` |
| `--quant` | a rule `PATTERN=QUANTISER:key=value,...`, ahead of the recipe's. Repeatable. | none | rule | user | `tools/rad_convert.cpp:491` |
| `--list-quantizers` | list every quantiser and its options, then exit |  | flag | user | `tools/rad_convert.cpp:492` |
| `--arch` | override the architecture id from the checkpoint | the checkpoint's | id | developer | `tools/rad_convert.cpp:493` |
| `--home` | the plugin home (as `RADIANCE_HOME`) | `RADIANCE_HOME`, else beside the executable | folder | developer | `tools/rad_convert.cpp:494` |
| `--kernels` | the kernel libraries to load, first wins | `RADIANCE_KERNELS`, else every library found | `A:B` list | developer | `tools/rad_convert.cpp:495` |
| `--tokenizer` | a tokenizer.json whose declared chain is baked in | the checkpoint's | file | user | `tools/rad_convert.cpp:496` |
| `--tokenizer2` | a second tokenizer.json, the container's second vocabulary (a generator with two) | none | file | user | `tools/rad_convert.cpp:497` |
| `--add` | one more .safetensors file merged in, names kept. Repeatable. | none | file | user | `tools/rad_convert.cpp:498` |
| `--config` | read config.json, generation_config.json and tokenizer.json from this folder | the checkpoint's own | folder | user | `tools/rad_convert.cpp:499` |
| `--imatrix` | a llama.cpp imatrix: expert popularity, column importances, error weighting | none | file | user | `tools/rad_convert.cpp:500` |
| `--chat-template` | a Jinja chat template baked in, over the checkpoint's | the checkpoint's | file | user | `tools/rad_convert.cpp:501` |
| `--set` | a metadata key `K=V`, seen by declare and written into the container. Repeatable. | none | `K=V` | user | `tools/rad_convert.cpp:502` |
| `--max-tok` | the max_tok declare runs at | 8192, or a generator's largest pass | whole number | developer | `tools/rad_convert.cpp:511` |
| `--max-ctx` | the context bound declare runs at | the checkpoint's training context | whole number | developer | `tools/rad_convert.cpp:512` |
| `--draft-model` | a drafter that ships as its own repository (DFlash2), merged under `draft.` | none | folder | user | `tools/rad_convert.cpp:515` |
| `--kv-cache-dtype` | the cache width declare runs at (picks the kernels it checks; the container is the same) | the first of bf16, i8 that resolves | `bf16` \| `i8` | developer | `tools/rad_convert.cpp:558` |
| `--max-spec` | the max_spec declare runs at; 0 leaves a draft head out | 4, or the drafter's block | whole number | developer | `tools/rad_convert.cpp:513` |
| `--reuse` | a container converted earlier from the same checkpoint; matching weights are copied. Repeatable. | none | file | user | `tools/rad_convert.cpp:526` |
| `--add-vision` | add a Gemma 4 MoE vision tower to a text-only container (input: the vision safetensors) | none | base `.rad` | user | `tools/rad_convert.cpp:516` |
| `--changed` | with `--reuse`: checkpoint tensors (one a line) that differ; weights reading them are converted | none | file | user | `tools/rad_convert.cpp:531` |
| `--lora` | a PEFT adapter merged into the weights before conversion. Repeatable. | none | file or folder | user | `tools/rad_convert.cpp:532` |
| `--lora-strength` | the strength of every `--lora` | 1 | number | user | `tools/rad_convert.cpp:533` |
| `--lora-map` | with `--lora`: a JSON map of the adapter's module names onto this checkpoint's | none | file | user | `tools/rad_convert.cpp:543` |
| `--in-place` | with `--reuse`: extend that container instead of writing a new one (`<file>.pre-append` keeps the old header) | off | flag | user | `tools/rad_convert.cpp:544` |
| `--replace` | with `--in-place`: write a weight the glob matches again. Repeatable. | none | glob | user | `tools/rad_convert.cpp:546` |
| `--defer` | leave weights the glob matches out, for a later `--in-place` run. Repeatable. | none | glob | user | `tools/rad_convert.cpp:545` |
| `--gpus` | **Refused on Windows:** rad-convert uses no GPU here. |  |  | user | `tools/rad_convert.cpp:547` |
| `--plan-only` | plan every weight's encoding, print it, write nothing | off | flag | user | `tools/rad_convert.cpp:524` |
| `--report` | the worst N quantisation errors to print | 20 | whole number | user | `tools/rad_convert.cpp:525` |
| `-v`, `--verbose` | debug logging | off | flag | user | `tools/rad_convert.cpp:566` |
| `-h`, `--help` | the usage text |  | flag | user | `tools/rad_convert.cpp:488` |

### `rad-export`: a fine-tune's output to a `.rad`

`bin\rad-export.cmd` runs it with the machine's Python. Reads `RADIANCE_IMAGE` and `UNSLOTH_POST_EXPORT`.

<!-- settings: rad-export -->

| Setting | Meaning | Default | Values | Who | Read at |
|---|---|---|---|---|---|
| `-o`, `--out` | the .rad to write | required | path | user | `tools/rad-export:573` |
| `--recipe` | the recipe: a name, a file, or auto | auto | name \| file \| `auto` | user | `tools/rad-export:574` |
| `--base` | the base checkpoint for a LoRA adapter | the adapter's `base_model_name_or_path` | folder | user | `tools/rad-export:575` |
| `--draft` | the drafter folder or Hub id, when the recipe merges one | the config's, else the recipe's | folder or id | user | `tools/rad-export:576` |
| `--set` | an extra rad-convert `--set K=V`, after the recipe's. Repeatable. | none | `K=V` | user | `tools/rad-export:577` |
| `--image` | the Radiance image for Docker | `RADIANCE_IMAGE`, the config's, the built-in | image | developer | `tools/rad-export:578` |
| `--rad-convert` | use this rad-convert binary instead of Docker | the installed one | path | user | `tools/rad-export:579` |
| `--recipes-dir` | the recipes folder | the installed (`share\radiance\recipes`) or the image's | folder | developer | `tools/rad-export:580` |
| `--memory` | Docker's memory limit for the convert | Docker's | e.g. `24g` | developer | `tools/rad-export:581` |
| `--config` | rad-export's config file | `~/.config/rad-export/config.json` | file | user | `tools/rad-export:582` |
| `--list-recipes` | list the recipes and exit | off | flag | user | `tools/rad-export:583` |
| `--json` | with `--list-recipes`: as JSON | off | flag | user | `tools/rad-export:584` |
| `--keep-merged` | keep the merged checkpoint of a LoRA adapter beside the output | off | flag | user | `tools/rad-export:585` |
| `--dry-run` | resolve everything, print the rad-convert command, convert nothing | off | flag | user | `tools/rad-export:586` |

### `brl-stacks.exe`

`bin\brl-stacks.exe <pid>` prints every thread's stack of a running process, for a server that stopped
making progress (`tools\STACKS.md` in the package;
[in the source](https://github.com/adamczhang/Brilliance/blob/main/win/tools/stacks/README.md)). It takes the process id and nothing else.

## Building from source

For a source checkout. Each is CPU-heavy except `setup.ps1 -CheckOnly`; run one at a time.

### `win\setup.ps1`: install the pinned build toolchain (source checkout)

Checks the machine and installs the build toolchain into `.toolchain\`, each archive SHA-256 checked. Safe to re-run.

<!-- settings: ps:setup.ps1 -->

| Setting | Meaning | Default | Values | Who | Read at |
|---|---|---|---|---|---|
| `-CheckOnly` | report only: download, install and change nothing | off | switch | developer | `win/setup.ps1:42` |
| `-Force` | re-extract and recreate everything under `.toolchain\` (matching downloads are kept) | off | switch | developer | `win/setup.ps1:43` |

### `win\build.ps1`: configure and build (source checkout)

Makes the shell a build shell (`win\env.ps1`), configures `build-win\<flavor>` and builds it. A build is CPU-heavy: run one at a time.

<!-- settings: ps:build.ps1 -->

| Setting | Meaning | Default | Values | Who | Read at |
|---|---|---|---|---|---|
| `-Flavor` | `host` (no GPU: the host backend, tools and host tests) or `hip` (the GPU build) | host | `host` \| `hip` | developer | `win/build.ps1:28` |
| `-Test` | run ctest afterwards | off | switch | developer | `win/build.ps1:29` |
| `-Jobs` | parallel jobs for the build and the tests | the logical processor count | whole number | developer | `win/build.ps1:30` |
| `-Reconfigure` | delete the CMake cache first | off | switch | developer | `win/build.ps1:31` |
| `-Target` | build only these targets | all | target names | developer | `win/build.ps1:32` |
| `-KeepGoing` | keep building past failures (`ninja -k 0`) | off | switch | developer | `win/build.ps1:33` |

### `win\package.ps1`: zip a built tree (source checkout)

Builds nothing: the tree must be current. Refuses a tree whose binaries report another commit, a missing DLL, unpinned FFmpeg, or an audit error.

<!-- settings: ps:package.ps1 -->

| Setting | Meaning | Default | Values | Who | Read at |
|---|---|---|---|---|---|
| `-BuildDir` | the built tree | `build-win\hip` | folder | developer | `win/package.ps1:56` |
| `-Out` | where the zip goes | `dist\` | folder | developer | `win/package.ps1:57` |

## Keeping this page right

`python -I win/tools/docs_check.py` reads the code for every setting and compares it with the tables
here: a setting read in code and missing here, or listed here and no longer read, is an error, and so is
a **Read at** file that does not name the setting. A **Read at** line that has moved is a warning;
`python -I win/tools/docs_check.py --fix-reference-lines` rewrites those lines. Each table follows a
`<!-- settings: KIND -->` line that tells the check what it lists (`env`, `yaml`, `radiance`,
`rad-convert`, `rad-export`, `profile-comment`, or `ps:<script>` for a script's parameters), and the
first cell names the setting in backticks. When you add a setting, add its row in the right table.
