// Registry contribution metadata is separate from the strict shortcut schema.
export const defaultKeybindings=registry=>registry.list('keybindings').map(({command,key,when})=>({command,key,when}));
