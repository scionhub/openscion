-- Drop legacy staging and object location tables (write path moved off D1)
DROP TABLE IF EXISTS object_locations;
DROP TABLE IF EXISTS staging_objects;
DROP TABLE IF EXISTS staging_meta;

