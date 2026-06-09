fix: keep macOS serve-web release assets usable

macOS CLI release builds now avoid Homebrew OpenSSL dylib linkage, and darwin
server-web ZIPs are published for `hucode serve-web`.
