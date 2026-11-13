# Blue and White Theme

Issue: #23

## Direction

Lokvyn follows the calm, utilitarian feel of desktop management tools such as
the Kiri reference: light blue-gray chrome (topbar, sidebar, status bar) frames
a white work surface, and a single blue accent marks primary actions, links,
and focus. The selected sidebar item is a raised white tile rather than a solid
fill, so the work surface keeps visual priority. Green, red, and amber remain
reserved for service status, errors, and preview labels.

## Typography

The platform system stack (SF Pro and PingFang SC on macOS) keeps Latin and
Chinese text consistent without bundling fonts. One scale covers every view:

| Role | Size | Weight |
| --- | --- | --- |
| Page title | 20px | 700 |
| Section title | 14-16px | 650 |
| Navigation, table, and form text | 13px | 400-600 |
| Secondary metadata | 12px | 400 |
| Group and column labels | 11px | 600 |

Nothing renders below 11px.

## Motion

Motion explains state changes and stays short (120-240ms, ease-out):

- hover, press, focus, and selection transitions on controls;
- a 4px fade-in when a view or inspector panel changes;
- staggered row entry in model lists (capped at 150ms of delay);
- a scale-in for custom select menus;
- a pulse on the online status dot;
- an animated sidebar collapse.

Animations use `transform` and `opacity`, apart from the sidebar's grid track
transition. `prefers-reduced-motion: reduce` disables them.
