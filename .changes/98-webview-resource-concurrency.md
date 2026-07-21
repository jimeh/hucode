fix(webview): prevent listener buildup during high-fan-out resource loads

Limit concurrent host-backed webview resource responses and cancel abandoned
transferable streams in `hucode serve-web`.
