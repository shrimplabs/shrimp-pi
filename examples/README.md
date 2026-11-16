# Examples

- `linux-remote.json`: template for a Linux host with a remote inference endpoint and Bubblewrap sandbox. Fill in the runtime paths, endpoint, and model.
- `config.json`: portable starting point; set the runtime paths, endpoint, and model.
- `task.md`: example engineering task with acceptance criteria.
- `supervisor-loop.sh`: shell transport example that dispatches and waits, then returns control for independent review or a blocker. It never accepts work automatically.
- `config.macos.json`: native Mac configuration using Seatbelt. Set the endpoint and model; Node and Pi are detected automatically.
- `native-mac-demo.mjs`: opt-in real-model demo with independent verification and same-session correction.
- `config.macos-external.json`: legacy external-launcher template; prefer the native Seatbelt configuration. External launcher isolation is operator supplied.

Run every command from the same host/access context used to spawn the daemon. `--no-sandbox` is an explicit trusted-worker option and does not disable the separate native read-only Git-review sandbox.
