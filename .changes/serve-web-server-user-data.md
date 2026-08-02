feat(web): persist serve-web user data on the server

Add an opt-in serve-web mode that keeps settings, keybindings, profiles, and
workbench state on the server so they follow users across browsers and devices.
Browser storage remains the default, first use can migrate existing browser
data, and secrets and sign-ins remain browser-local.
