import Foundation

/// Optional profile details for `PATCH /v1/cloud/auth/me`: nil leaves a field
/// unchanged and an empty string clears it.
struct CloudProfileDetailsUpdate: Equatable {
    var about: String?
    var location: String?
    var timeZone: String?
    var website: String?
    var birthday: String?

    init(
        about: String? = nil,
        location: String? = nil,
        timeZone: String? = nil,
        website: String? = nil,
        birthday: String? = nil
    ) {
        self.about = about
        self.location = location
        self.timeZone = timeZone
        self.website = website
        self.birthday = birthday
    }
}

/// An editable profile row that can carry a server validation error.
enum ProfileField: Equatable {
    case kordiId, about, location, timeZone, website, birthday

    init?(errorCode: String) {
        switch errorCode {
        case "invalid_kordi_id", "kordi_id_taken", "kordi_id_change_locked": self = .kordiId
        case "invalid_about": self = .about
        case "invalid_location": self = .location
        case "invalid_time_zone": self = .timeZone
        case "invalid_website": self = .website
        case "invalid_birthday": self = .birthday
        default: return nil
        }
    }
}

struct ProfileFieldError: Equatable {
    let field: ProfileField
    let message: String
}

/// The profile editor's working copy. Empty strings mean unset.
struct ProfileDraft: Equatable {
    static let aboutLimit = 280
    static let locationLimit = 80
    static let websiteLimit = 200
    static let kordiIdLimit = 30

    var name = ""
    /// The custom handle only; empty when the account uses its number.
    var kordiId = ""
    var about = ""
    var location = ""
    var timeZone = ""
    var website = ""
    var birthday = ""

    init() {}

    init(account: CloudAccount?) {
        name = account?.preferredName ?? ""
        kordiId = Self.customHandle(account?.kordiId) ?? ""
        about = account?.about ?? ""
        location = account?.location ?? ""
        timeZone = account?.timeZone ?? ""
        website = account?.website ?? ""
        birthday = account?.birthday ?? ""
    }

    /// The account's custom handle, or nil when its Kordi ID is the nine-digit number.
    static func customHandle(_ kordiId: String?) -> String? {
        guard let value = kordiId?.nonEmpty else { return nil }
        return value.allSatisfy({ $0.isASCII && $0.isNumber }) ? nil : value
    }

    /// The nine-digit number when that is the account's current Kordi ID.
    static func accountNumber(_ kordiId: String?) -> String? {
        guard let value = kordiId?.nonEmpty, customHandle(value) == nil else { return nil }
        return value
    }

    /// Strips a leading "@", keeps ASCII letters and digits, and caps the length.
    static func sanitizedKordiId(_ value: String) -> String {
        var text = Substring(value)
        while text.first == "@" { text = text.dropFirst() }
        return String(text.filter { $0.isASCII && ($0.isLetter || $0.isNumber) }.prefix(kordiIdLimit))
    }

    static func capped(_ value: String, _ limit: Int) -> String {
        value.count > limit ? String(value.prefix(limit)) : value
    }

    func value(for field: ProfileField) -> String {
        switch field {
        case .kordiId: kordiId
        case .about: about
        case .location: location
        case .timeZone: timeZone
        case .website: website
        case .birthday: birthday
        }
    }

    /// Only the fields that differ from `saved`, trimmed; "" clears a field.
    func changes(from saved: ProfileDraft) -> (kordiId: String?, details: CloudProfileDetailsUpdate) {
        func changed(_ draft: String, _ original: String) -> String? {
            let clean = draft.trimmingCharacters(in: .whitespacesAndNewlines)
            return clean == original ? nil : clean
        }
        return (
            changed(kordiId, saved.kordiId),
            CloudProfileDetailsUpdate(
                about: changed(about, saved.about),
                location: changed(location, saved.location),
                timeZone: changed(timeZone, saved.timeZone),
                website: changed(website, saved.website),
                birthday: changed(birthday, saved.birthday)
            )
        )
    }

    /// True when saving would change something other than whitespace.
    func hasChanges(from saved: ProfileDraft) -> Bool {
        let (kordiId, details) = changes(from: saved)
        return kordiId != nil
            || details != CloudProfileDetailsUpdate()
            || name.trimmingCharacters(in: .whitespacesAndNewlines) != saved.name
    }
}

/// Birthday and time zone presentation for the profile editor.
enum ProfileFormatting {
    private static let utc = TimeZone(identifier: "UTC") ?? .gmt

    static var calendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = utc
        return calendar
    }

    private static let isoDay: DateFormatter = {
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = utc
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter
    }()

    private static let longDay: DateFormatter = {
        let formatter = DateFormatter()
        formatter.timeZone = utc
        formatter.dateStyle = .long
        formatter.timeStyle = .none
        return formatter
    }()

    static func birthdayDate(_ value: String) -> Date? {
        value.nonEmpty.flatMap { isoDay.date(from: $0) }
    }

    static func birthdayString(_ date: Date) -> String {
        isoDay.string(from: date)
    }

    static func birthdayLabel(_ value: String) -> String? {
        birthdayDate(value).map { longDay.string(from: $0) }
    }

    static var birthdayRange: ClosedRange<Date> {
        let start = isoDay.date(from: "1900-01-01") ?? .distantPast
        return start...Date()
    }

    /// Where the picker starts when no birthday is set.
    static var defaultBirthday: Date {
        isoDay.date(from: "2000-01-01") ?? Date()
    }

    /// "GMT+0", "GMT-5", or "GMT+5:30".
    static func gmtOffset(_ zone: TimeZone, at date: Date = Date()) -> String {
        let seconds = zone.secondsFromGMT(for: date)
        let sign = seconds < 0 ? "-" : "+"
        let hours = abs(seconds) / 3600
        let minutes = (abs(seconds) % 3600) / 60
        return minutes == 0
            ? "GMT\(sign)\(hours)"
            : "GMT\(sign)\(hours):\(String(format: "%02d", minutes))"
    }

    static func timeZoneName(_ zone: TimeZone) -> String {
        zone.localizedName(for: .generic, locale: .current)
            ?? zone.localizedName(for: .standard, locale: .current)
            ?? zone.identifier
    }

    /// "Western European Time, GMT+0", or nil for an unknown identifier.
    static func timeZoneLabel(_ identifier: String) -> String? {
        guard let zone = identifier.nonEmpty.flatMap(TimeZone.init(identifier:)) else { return nil }
        return "\(timeZoneName(zone)), \(gmtOffset(zone))"
    }

    /// When the Kordi ID can change again, or nil when it can change now.
    static func kordiIdLockedUntil(_ value: String?, now: Date = Date()) -> Date? {
        guard let value = value?.nonEmpty else { return nil }
        let precise = ISO8601DateFormatter()
        precise.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let date = precise.date(from: value) ?? ISO8601DateFormatter().date(from: value)
        guard let date, date > now else { return nil }
        return date
    }

    /// "Changes again on Mar 4, 2027".
    static func kordiIdUnlockCaption(_ date: Date) -> String {
        "Changes again on \(date.formatted(date: .abbreviated, time: .omitted))"
    }

    /// A stable hue in 0..<1 for the profile banner.
    static func bannerHue(seed: String) -> Double {
        var hash: UInt32 = 2_166_136_261
        for byte in seed.utf8 {
            hash ^= UInt32(byte)
            hash = hash &* 16_777_619
        }
        return Double(hash % 360) / 360
    }
}
