# Gentle hills, connected water and reset defaults

User feedback: add Reset defaults, replace the noisy terrain feel with game-believable landforms, and connect elevated water to lower water with rivers. The user selected **gentler hills and wide river valleys** as the visual target.

1. Add a menu Reset defaults button. Cancel current work, restore every default (including seed/output), save settings, refresh controls and preview, and require Generate before exporting again. Verify via browser interactions.
2. Preserve lake outlet channels below the ordinary rainfall/accumulation threshold, following the actual downhill receiver graph to a lake, ocean, edge or larger river. Rainfall zero still produces no rivers. Add synthetic low-flow and lake-chain regressions; verify all downstream and lake-junction invariants.
3. Rework terrain shaping around broad rolling uplands and connected low corridors. Domain warping and elevation-dependent detail add variation without equal-strength fine ridges everywhere. Keep seed determinism, world-space coordinates, island edges and existing height/sea-level controls. Add measurable multiscale and feature-scale coverage, then inspect generated screenshots across seeds.
4. Make the river overlay continuous and readable at preview scale so actual high-to-low connections appear in the viewport/minimap. Keep export widths and masks physically scaled.
5. Run CPU, GPU and app checks including downhill raster export tests. Review the completed diff, record results and save changes on the existing branch. Do not push or merge.

Visual acceptance: broad connected hills and valleys dominate; erosion adds local drainage rather than turning an evenly noisy field into large filled lake patches. Elevated wet lakes have visible descending outlets wherever an in-world downstream receiver exists. Export still has no uphill water or channel-floor steps in the tested cases.
