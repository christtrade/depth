# Security

## Reporting a vulnerability

Use GitHub's **Report a vulnerability** button on the Security tab of this
repository. That opens a private advisory only the maintainer can see.

If you can't use GitHub, email **security@christtrade.com**.

Please include what you found, how to reproduce it, and what an attacker gets
out of it. A working proof of concept helps a lot. Don't open a public issue for
a vulnerability, and please don't test against christtrade.com - reproduce it
locally against your own build.

You'll get an acknowledgement within a few days. Depth is maintained by one
person, so there is no SLA and no bug bounty. Fixes ship in the next release.
Once a fix is out, you're welcome to write it up publicly, and you'll be
credited in the advisory unless you'd rather not be.

## Supported versions

Depth is pre-1.0. Only the latest published version gets fixes. There are no
backports to older 0.x lines.

## Threat model

Depth renders untrusted market data and runs untrusted plugin code inside your
page. Those are two different problems and they get two different answers.

One boundary to be clear about first: Depth ships the plugin **runtime** - the
worker, the permission gates, the WASM host. It does not ship an authoring tool.
The script editor is part of ChristTrade, not of this library. How plugin source
reaches Depth in your application is your design decision, and a security-
relevant one.

### Market data is untrusted, and Depth treats it that way

Symbol names, adapter responses, and anything else crossing `IDataAdapter` is
data an attacker may control. Depth renders it to canvas and to React, never
through `innerHTML`. A crash, an infinite loop, or script execution triggered by
adapter output is a bug - report it.

### Plugins are code you chose to run

This is the important part, so it's stated plainly:

**The plugin sandbox is a guardrail, not a security boundary.**

A plugin is a program. Starting one is the same act as running any other program
on your machine. Depth makes that act deliberate and makes the plugin's
intentions legible. It does not make a malicious plugin safe.

**Scripted plugins execute on the main thread.** This is the part people get
wrong, so it is first. A scripted plugin's compute path - `init`, `update`,
`draw` - runs in a Web Worker, and inside that worker `fetch`,
`XMLHttpRequest`, `WebSocket`, and `importScripts` are all shadowed. But render
handlers, hit tests and panel bodies cannot cross the worker boundary as
functions, so the same script is *also* evaluated on the main thread to resolve
them (see `src/core/script-scope.ts`). On the main thread there is a DOM, a
global `fetch`, and the rest of your page.

The worker exists to keep indicator maths off the render thread. It is not an
isolation boundary, and nothing in Depth is.

So what the permission system actually gives you is **declaration, not
containment**:

- A plugin's manifest states the capabilities it wants and the network origins
  it intends to talk to. `ctx.fetch` enforces those origins exactly - scheme,
  host and port must all match - and every other capability is withheld unless
  asked for.
- That makes a plugin's intentions inspectable *before* it runs, which is the
  useful property. Show the manifest to whoever is about to press start.
- It does not stop a hostile script that ignores `ctx` entirely and uses the
  ambient globals it was handed on the main thread.

What Depth does not do:

- It does not sandbox plugin code. See above. Treat every plugin as trusted code
  running in your page, because that is what it is.
- It does not protect you from a plugin doing exactly what it declared. A plugin
  granted `network` and `data:read` can read your chart data and send it to its
  declared origin. That is the feature.
- It does not vet plugin code. There is no signing, no review queue, no registry.
- It does not isolate credentials from the plugin that owns them. If you give a
  data-source plugin your broker or market-data API key, that plugin has your
  key. Bring-your-own-key means the key lives in the browser, in local storage,
  unencrypted, and readable by any code already running in the page.
- It is not a defence against a compromised host page. If an attacker can run
  script in your app, Depth's permission gates are irrelevant.

Depth does not execute plugin code on its own. A plugin runs when the host
creates and starts it - note that creating a scripted extension runs its
`onInstall` immediately, so "add to catalog" and "start" should be separate
actions in your UI.

### If you host Depth for other people

Depth will run whatever plugin source you hand it. Where that source comes from
is on you, and the answer decides your exposure:

- **You author the plugins.** Nothing to worry about beyond your own code.
- **Your users author their own.** They run their code in their own browser, in
  their own session. That's fine.
- **Your users can share plugins with each other**, through an editor, a
  marketplace, a paste box, a URL. You have built a code distribution channel,
  and you own the review problem that comes with it.

For that third case, Depth gives you the manifest - the permissions and network
origins the plugin declares - so you can show a user what they're about to run
before they run it. Show it. Depth will not prompt on your behalf.

### In scope

- Script execution, prototype pollution, or crashes driven by adapter data,
  saved chart state (`parseChartSave` / `chart.restore`), or stored preferences.
  Anything Depth ingests as *data* rather than as code.
- `ctx.fetch` reaching an origin the manifest did not declare, or a capability
  gate handing over something that was never asked for. The gates should do what
  they say they do, even though they are not a containment boundary.
- Escaping the WASM plugin host.
- One plugin reading another plugin's private storage.
- A plugin affecting a Depth instance other than the one it was started in.

### Out of scope

- A scripted plugin reaching main-thread globals, the DOM, or the network
  outside `ctx.fetch`. That is documented behaviour, not a vulnerability - see
  the threat model above.
- A plugin the user started abusing the permissions it declared and was granted.
- A plugin hanging its own worker, or a user's own script looping forever.
- Anything that needs script execution in the host page to begin with.
- Anything requiring physical or local access to the user's machine.
- Vulnerabilities in a consumer's application, in their data adapter, or in a
  third-party plugin. Report those to whoever wrote them.
