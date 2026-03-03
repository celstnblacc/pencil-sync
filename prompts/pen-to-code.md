# Pen-to-Code Sync

Update the frontend code to match design changes from the .pen file.

## Target Code
- **Code directory:** `{{CODE_DIR}}`
- **File patterns:** {{CODE_GLOBS}}
- **Framework:** {{FRAMEWORK}}
- **Styling:** {{STYLING}}
{{DESIGN_CHANGES}}
{{STYLE_FILES}}
## Instructions

For EACH change listed above, update the code to match:

### Color changes (`fill` property)
Colors in this project use CSS custom properties with Tailwind:
- `globals.css` defines: `--color-token-name: R G B;` (space-separated RGB channels)
- `tailwind.config.js` maps: `'token-name': 'rgb(var(--color-token-name) / ...)'`
- Components use: `bg-token-name`, `text-token-name`, etc.

When a `fill` changes:
1. Convert the NEW hex to space-separated RGB: `#401417` → `64 20 23`
2. Find the CSS variable in `globals.css` that the element's Tailwind class maps to
3. Update the variable value in ALL theme blocks (`:root`, `[data-theme="monokai"]`, etc.)
4. Do NOT rename classes — only change the CSS variable VALUES

### Text changes (`content` property)
Find the matching text in the component and update it.

### Typography changes (`fontSize`, `fontWeight`, `fontFamily`)
Update the corresponding Tailwind classes (e.g. `text-sm` → `text-base`, `font-bold` → `font-semibold`).

## Rules
- ONLY change what's listed in the design changes above
- PRESERVE all functional code (handlers, state, API calls, logic)
- After making changes, list what you updated
