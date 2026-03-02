# Conflict Resolution: Design + Code Both Changed

Both the .pen design file and the code have been modified since the last sync. You need to merge both sets of changes intelligently.

## Design
- **Pen file:** `{{PEN_FILE}}`
- **Screens affected:** {{SCREENS}}

## Code
- **Code directory:** `{{CODE_DIR}}`
- **Framework:** {{FRAMEWORK}}
- **Styling:** {{STYLING}}
- **Changed code files:**
- {{CHANGED_CODE_FILES}}

## Instructions

1. First, read BOTH sides to understand all changes:
   - Use Pencil MCP tools to read the .pen file and understand design changes
   - Read the changed code files to understand code-side changes

2. Identify conflicts vs. non-conflicting changes:
   - **Non-conflicting**: Changes to different components or properties → apply both
   - **Conflicting**: Same property changed in both design and code

3. For non-conflicting changes:
   - Apply design changes to code (pen-to-code direction)
   - Apply code changes to design (code-to-pen direction)

4. For conflicting changes, apply this priority:
   - Visual/aesthetic properties (colors, typography, spacing) → **design wins** (designer intent)
   - Layout structure changes → **merge carefully**, prefer design structure
   - New components → keep from whichever side added them

5. Preserve ALL functional code (event handlers, state, API calls, business logic).

6. Use `mcp__pencil__get_screenshot` to verify the final design state.

7. After resolving, provide a summary of:
   - What design changes were applied to code
   - What code changes were applied to design
   - Any conflicts and how they were resolved
