# Code-to-Pen Sync

You are syncing frontend code changes back into a .pen design file. Your job is to update the design to reflect code changes to visual properties.

## Source Code
- **Code directory:** `{{CODE_DIR}}`
- **Framework:** {{FRAMEWORK}}
- **Styling:** {{STYLING}}
- **Changed files:**
- {{CHANGED_FILES}}

## Target Design
- **Pen file:** `{{PEN_FILE}}`

## Instructions

1. Read the changed code files listed above to understand what visual properties changed.

2. Use the Pencil MCP tools to read the current .pen file state:
   - Use `mcp__pencil__batch_get` to find the corresponding design elements
   - Use `mcp__pencil__get_variables` to read current design tokens

3. For each visual change in code, update the corresponding .pen element:
   - Layout changes (flex, grid, gaps) → update frame layout properties
   - Color changes → update fill, stroke, text colors
   - Typography changes → update font properties on text nodes
   - Spacing changes → update padding, margins, gaps
   - Size changes → update width, height
   - New components → create corresponding frames/components in .pen

4. Use the appropriate Pencil MCP tools to apply changes:
   - `mcp__pencil__batch_design` for structural and property updates
   - `mcp__pencil__set_variables` for design token updates

5. **DO NOT** modify design elements that don't have corresponding code changes.

6. **DO NOT** remove design-only annotations, notes, or elements that serve as design documentation.

7. Use `mcp__pencil__get_screenshot` to verify your changes look correct.

8. After making changes, briefly list what was updated in the design.
