// The ranking rule: more points, then more 10s (an X is a 10), then more X.
// The server uses the same rule to order the leaderboard.
function compareEntries(a, b) {
    return (b.total_score - a.total_score)
        || ((b.ten_count ?? 0) - (a.ten_count ?? 0))
        || ((b.x_count ?? 0) - (a.x_count ?? 0));
}

// Sort the entries and give each one a rank. Entries that are equal in all three
// values share a rank. The next rank skips the shared places (1, 1, 3).
function rankEntries(entries) {
    const sorted = [...entries].sort(compareEntries);
    let rank = 0;
    return sorted.map((entry, index) => {
        if (index === 0 || compareEntries(sorted[index - 1], entry) !== 0) rank = index + 1;
        return { entry, rank };
    });
}
