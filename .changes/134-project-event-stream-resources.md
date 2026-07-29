fix(omni): bound project event stream resources

Cap serve-web project event clients, coalesce updates for slow connections, and
clean up stream resources when clients or the server close.
