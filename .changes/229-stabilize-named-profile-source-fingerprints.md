fix(migration): stabilize named-profile source fingerprints

Keep reviewed named-profile imports valid when the source editor rewrites
unrelated application state or changes another profile. Changes to the selected
profile's normalized catalog metadata still invalidate Review.
