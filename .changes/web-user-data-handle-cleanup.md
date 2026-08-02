fix(web): release server user-data handles on disconnect

Release open server-backed WebUser file handles when their owning serve-web
client finally disconnects, while preserving reconnection grace and isolating
handles belonging to other clients.
