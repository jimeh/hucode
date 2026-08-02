fix(web): load Omni with server-side user data

Load the shared Omni registrations when serve-web uses server-side user-data
storage, preventing the default Omni page from failing during startup.
