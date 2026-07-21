fix(terminal): support OSC 52 clipboard in serve-web

OSC 52 terminal writes and queries now use the browser's system clipboard in
serve-web when browser permissions allow, matching desktop behavior. Repeated
blocked queries share one permission prompt.
