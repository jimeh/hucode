fix(extensions): restore proposed API access for Microsoft extensions

Hucode now ships Microsoft's `extensionEnabledApiProposals` allowlist, so
extensions such as GitHub Pull Requests can use their proposed APIs again
instead of failing with "CANNOT use API proposal" errors.
