package repository

// SQLite task inputs retain their JSON shape while individual secrets are
// encrypted. Read the operation/input intent; supplier model IDs are opaque.
const upscaleTaskPredicate = `(COALESCE(tasks.operation, '') LIKE 'media.upscale.%' OR COALESCE(CASE WHEN json_valid(tasks.input_json) THEN json_type(tasks.input_json, '$.upscale') END, '') = 'object')`
