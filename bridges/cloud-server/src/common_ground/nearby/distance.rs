//! Rounding, distances and distance bands. Other people's distance is only
//! ever returned as a band; precise coordinates never leave the server.

use serde_json::{json, Value};

/// Earth radius for the haversine distance, in meters.
const EARTH_RADIUS_M: f64 = 6_371_000.0;
/// Meters per degree of latitude on that sphere.
const METERS_PER_DEGREE: f64 = EARTH_RADIUS_M * std::f64::consts::PI / 180.0;

/// The band edges (`maxMeters`), smallest first. A range filter takes one
/// of these values.
pub(in crate::common_ground) const BANDS: [i32; 6] = [500, 1_000, 2_000, 5_000, 10_000, 25_000];
/// The farthest anyone is seen through nearby.
pub(in crate::common_ground) const MAX_RANGE_M: i32 = 25_000;

/// A coordinate rounded to 3 decimals (about 110 m), as stored.
pub(in crate::common_ground) fn round3(value: f64) -> f64 {
    (value * 1_000.0).round() / 1_000.0
}

/// The haversine distance between two points, in meters.
pub(in crate::common_ground) fn haversine_m(lat1: f64, lon1: f64, lat2: f64, lon2: f64) -> f64 {
    let (p1, p2) = (lat1.to_radians(), lat2.to_radians());
    let dp = (lat2 - lat1).to_radians();
    let dl = (lon2 - lon1).to_radians();
    let a = (dp / 2.0).sin().powi(2) + p1.cos() * p2.cos() * (dl / 2.0).sin().powi(2);
    2.0 * EARTH_RADIUS_M * a.sqrt().min(1.0).asin()
}

/// Whether `range_m` is one of the band values.
pub(in crate::common_ground) fn valid_range(range_m: i64) -> bool {
    BANDS.iter().any(|band| i64::from(*band) == range_m)
}

/// A distance within a range: a distance exactly on the edge is inside.
pub(in crate::common_ground) fn within(distance_m: f64, range_m: i32) -> bool {
    distance_m <= f64::from(range_m)
}

/// The smallest band whose `maxMeters` is at least the distance, as
/// `(minMeters, maxMeters)`. `None` past the farthest band.
pub(in crate::common_ground) fn band(distance_m: f64) -> Option<(i32, i32)> {
    let mut min = 0;
    for max in BANDS {
        if within(distance_m, max) {
            return Some((min, max));
        }
        min = max;
    }
    None
}

/// `{minMeters, maxMeters}` for a distance, the farthest band past it.
pub(in crate::common_ground) fn band_view(distance_m: f64) -> Value {
    let (min, max) = band(distance_m).unwrap_or((BANDS[4], MAX_RANGE_M));
    json!({ "minMeters": min, "maxMeters": max })
}

/// The label a push shows for a band's `maxMeters`.
pub(in crate::common_ground) fn band_label(max_m: i32) -> &'static str {
    const LABELS: [&str; 6] = [
        "Under 500 m",
        "Under 1 km",
        "1–2 km",
        "2–5 km",
        "5–10 km",
        "10–25 km",
    ];
    let index = BANDS.iter().position(|band| max_m <= *band);
    LABELS[index.unwrap_or(LABELS.len() - 1)]
}

/// Half the side of a box around a point that holds every point within
/// `range_m`, as (latitude degrees, longitude degrees), with a small margin.
/// Near the poles the longitude span is the whole circle.
pub(in crate::common_ground) fn bounding_box(latitude: f64, range_m: i32) -> (f64, f64) {
    let dlat = f64::from(range_m) / METERS_PER_DEGREE * 1.01;
    let cos = latitude.to_radians().cos();
    let dlon = if cos < 0.01 { 360.0 } else { dlat / cos };
    (dlat, dlon.min(360.0))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn coordinates_round_to_three_decimals() {
        assert_eq!(round3(31.230_416_7), 31.23);
        assert_eq!(round3(121.473_701), 121.474);
        assert_eq!(round3(-0.000_4), -0.0);
        assert_eq!(round3(-33.856_8), -33.857);
        assert_eq!(round3(180.0), 180.0);
    }

    #[test]
    fn haversine_matches_known_distances() {
        assert_eq!(haversine_m(10.0, 20.0, 10.0, 20.0), 0.0);
        // One degree of latitude on this sphere.
        let degree = haversine_m(0.0, 0.0, 1.0, 0.0);
        assert!((degree - 111_194.93).abs() < 0.1, "{degree}");
        // One degree of longitude at 60° is about half that.
        let east = haversine_m(60.0, 0.0, 60.0, 1.0);
        assert!((east - 55_597.5).abs() < 5.0, "{east}");
        // Across the antimeridian is short.
        let across = haversine_m(0.0, 179.999, 0.0, -179.999);
        assert!(across < 250.0, "{across}");
        // Shanghai to Beijing, about 1,067 km.
        let far = haversine_m(31.23, 121.474, 39.904, 116.407);
        assert!((far - 1_067_000.0).abs() < 5_000.0, "{far}");
    }

    #[test]
    fn bands_include_their_upper_edge() {
        assert_eq!(band(0.0), Some((0, 500)));
        assert_eq!(band(500.0), Some((0, 500)), "500 m exactly is under 500 m");
        assert_eq!(band(500.001), Some((500, 1_000)));
        assert_eq!(band(1_000.0), Some((500, 1_000)));
        assert_eq!(band(1_999.9), Some((1_000, 2_000)));
        assert_eq!(band(2_000.0), Some((1_000, 2_000)));
        assert_eq!(band(5_000.0), Some((2_000, 5_000)));
        assert_eq!(band(10_000.0), Some((5_000, 10_000)));
        assert_eq!(band(25_000.0), Some((10_000, 25_000)));
        assert_eq!(band(25_000.1), None);
        assert_eq!(
            band_view(700.0),
            json!({"minMeters": 500, "maxMeters": 1000})
        );
    }

    #[test]
    fn the_range_filter_keeps_the_edge_and_drops_past_it() {
        for range in BANDS {
            assert!(within(f64::from(range), range));
            assert!(within(f64::from(range) - 1.0, range));
            assert!(!within(f64::from(range) + 1.0, range));
        }
        assert!(valid_range(2_000));
        assert!(!valid_range(1_500));
        assert!(!valid_range(0));
    }

    #[test]
    fn labels_follow_the_bands() {
        let labels: Vec<&str> = BANDS.iter().map(|max| band_label(*max)).collect();
        assert_eq!(
            labels,
            [
                "Under 500 m",
                "Under 1 km",
                "1–2 km",
                "2–5 km",
                "5–10 km",
                "10–25 km"
            ]
        );
    }

    #[test]
    fn the_box_holds_every_point_in_range() {
        let (lat, lon) = (59.9, 10.75);
        let (dlat, dlon) = bounding_box(lat, MAX_RANGE_M);
        // A point just inside the range to the north and to the east.
        let north = lat + 24_999.0 / METERS_PER_DEGREE;
        assert!(north - lat <= dlat);
        let mut east = lon;
        while haversine_m(lat, lon, lat, east + 0.001) <= 24_999.0 {
            east += 0.001;
        }
        assert!(east - lon <= dlon);
        assert_eq!(bounding_box(89.999, 500).1, 360.0);
    }
}
