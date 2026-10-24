@tool
extends EditorScript
## Imports a Terrain3D heightmap bundle exported by the terrain generator.
##
## Usage: copy the unzipped bundle folder into your Godot project, add a Terrain3D node and select it,
## open this script in the Script editor and choose File > Run (Ctrl+Shift+X).
## Afterwards set the Terrain3D data directory and save the scene.


func _run() -> void:
	var selection := EditorInterface.get_selection().get_selected_nodes()
	if selection.size() != 1 or not (selection[0] is Terrain3D):
		push_error("Terrain3D import: select exactly one Terrain3D node, then run the script again.")
		return
	var bundle_dir: String = get_script().resource_path.get_base_dir().get_base_dir()
	var err := import_bundle(selection[0], bundle_dir)
	if err != OK:
		push_error("Terrain3D import failed: %s" % error_string(err))
		return
	print("Terrain3D import done. Set the Terrain3D data directory and save the scene to keep the regions.")


## Imports every height tile listed in `bundle_dir/world.json` into `terrain`. Returns OK or an Error.
static func import_bundle(terrain: Terrain3D, bundle_dir: String) -> Error:
	if terrain.data == null:
		push_error("Terrain3D import: the Terrain3D node has no data yet (is it inside the scene tree?).")
		return ERR_UNCONFIGURED
	var json_path := bundle_dir.path_join("world.json")
	if not FileAccess.file_exists(json_path):
		push_error("Terrain3D import: %s not found." % json_path)
		return ERR_FILE_NOT_FOUND
	var world = JSON.parse_string(FileAccess.get_file_as_string(json_path))
	if typeof(world) != TYPE_DICTIONARY or world.get("version", 0) != 1:
		push_error("Terrain3D import: unsupported or invalid world.json.")
		return ERR_INVALID_DATA

	var tile_size := int(world["tileSize"])
	terrain.vertex_spacing = float(world["vertexSpacing"])
	terrain.change_region_size(int(world["regionSize"]))

	var r16_range := Vector2(0, 1)
	if world["r16Range"] != null:
		r16_range = Vector2(float(world["r16Range"]["min"]), float(world["r16Range"]["max"]))

	var tiles: Array = world["tiles"]
	for i in tiles.size():
		var tile: Dictionary = tiles[i]
		var path := bundle_dir.path_join(tile["file"])
		var img: Image = Terrain3DUtil.load_image(
			path, ResourceLoader.CACHE_MODE_IGNORE, r16_range, Vector2i(tile_size, tile_size)
		)
		if img == null:
			push_error("Terrain3D import: could not load %s" % path)
			return ERR_FILE_CANT_READ
		var pos: Array = tile["position"]
		# Positions are world meters (tile origin); Terrain3D divides by region_size * vertex_spacing itself.
		var images: Array[Image] = [img, null, null]
		terrain.data.import_images(images, Vector3(pos[0], pos[1], pos[2]), 0.0, 1.0)
		print("Imported %d/%d" % [i + 1, tiles.size()])
	return OK
