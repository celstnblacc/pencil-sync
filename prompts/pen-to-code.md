# Pen-to-Code Sync

You are syncing a .pen design file to frontend code. Your job is to update the code to match the current design, while preserving all functional logic.

## Source Design
- **Pen file:** `{{PEN_FILE}}`
- **Screens to sync:** {{SCREENS}}

## Target Code
- **Code directory:** `{{CODE_DIR}}`
- **File patterns:** {{CODE_GLOBS}}
- **Framework:** {{FRAMEWORK}}
- **Styling:** {{STYLING}}

## Instructions

1. Use the Pencil MCP tools to read the .pen file:
   - Use `mcp__pencil__batch_get` to read screen structure, components, and layout
   - Use `mcp__pencil__get_variables` to read design tokens (colors, spacing, typography)
   - Use `mcp__pencil__get_screenshot` to visually verify what you're reading

2. Read the existing code files in `{{CODE_DIR}}` matching patterns: {{CODE_GLOBS}}

3. Compare the design with existing code and update ONLY visual properties:
   - Layout structure (flex direction, grid, gaps, padding, margins)
   - Colors, backgrounds, borders
   - Typography (font sizes, weights, families, line heights)
   - Spacing and sizing
   - Border radius, shadows, opacity
   - Component hierarchy and nesting

4. **PRESERVE** all functional code:
   - Event handlers (onClick, onChange, onSubmit, etc.)
   - State management (useState, useContext, stores)
   - API calls and data fetching
   - Business logic and conditionals
   - Imports of non-styling modules
   - Comments explaining business logic

5. For {{STYLING}} styling:
   - **tailwind**: Update Tailwind classes on elements
   - **css-modules**: Update .module.css files
   - **css**: Update CSS files
   - **styled-components**: Update styled component definitions

6. If a component exists in the design but not in code, create a new component file.
   If a component exists in code but not in the design, leave it untouched.

7. After making changes, briefly list what was updated.
