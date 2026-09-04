/* ==========================================================================
   Seed data — matches the static player board (jobs.html) so the front-end
   and API show the same 14 athletes across 8 sports.
   ========================================================================== */
const bcrypt = require("bcryptjs");
const db = require("./db");

const P = [
  ["p_1", "Ahmed Gamal", "Football", "Striker (ST)", "Al Ahly SC", "Egypt", 850000, true, 2, 23, 185, "Right", "Pro", "ahmed gamal striker forward football al ahly egypt pace finishing"],
  ["p_2", "Dario Petrović", "Basketball", "Shooting Guard (SG)", "KK Split", "Croatia", 620000, true, 1, 25, 198, "Right", "Pro", "dario petrovic shooting guard basketball split croatia three point defense"],
  ["p_3", "Elena Vasquez", "Tennis", "Singles", "Rafa Academy", "Spain", 2100000, true, 3, 22, 172, "Left", "Pro", "elena vasquez tennis singles spain serve backhand atp"],
  ["p_4", "Anna Kowalska", "Volleyball", "Outside Hitter", "AZS Warszawa", "Poland", 390000, true, 4, 21, 188, "Right", "Semi-pro", "anna kowalska outside hitter volleyball warsaw poland block spike"],
  ["p_5", "Lukas Weber", "Handball", "Left Wing (LW)", "THW Kiel", "Germany", 540000, true, 5, 24, 191, "Right", "Pro", "lukas weber left wing handball kiel germany speed throw"],
  ["p_6", "David O'Connor", "Golf", "Professional", "European Tour", "Ireland", 1100000, true, 6, 29, 183, "Right", "Pro", "david oconnor golf driver irish putt handicap tour"],
  ["p_7", "Rima Al-Sayed", "Karate", "Kumite", "Egyptian Federation", "Egypt", 260000, true, 7, 20, 168, "Right", "Pro", "rima alsayed karate kumite egypt kata medals champion"],
  ["p_8", "Emma Larsson", "Swimming", "Freestyle", "Swedish Swimming", "Sweden", 460000, true, 7, 23, 176, "Right", "Pro", "emma larsson swimming freestyle sweden 100m olympic records"],
  ["p_9", "Carlos Mendes", "Football", "Midfielder (CM)", "SL Benfica", "Portugal", 1400000, false, 8, 26, 179, "Both", "Pro", "carlos mendes central midfielder football benfica portugal passing vision"],
  ["p_10", "Marcus Lee", "Basketball", "Power Forward (PF)", "Seoul Knights", "USA", 750000, false, 9, 27, 206, "Right", "Pro", "marcus lee power forward basketball seoul usa rebounding inside game"],
  ["p_11", "Yuki Tanaka", "Tennis", "Singles / Doubles", "Japan Tennis", "Japan", 980000, false, 10, 24, 174, "Right", "Pro", "yuki tanaka tennis singles japan serve forehand doubles"],
  ["p_12", "Kenji Sato", "Volleyball", "Setter", "Osaka Blazers", "Japan", 410000, false, 11, 22, 182, "Right", "Semi-pro", "kenji sato setter volleyball osaka japan setting court vision"],
  ["p_13", "Yusuf Demir", "Handball", "Right Wing (RW)", "Galatasaray", "Turkey", 470000, true, 12, 21, 188, "Left", "Semi-pro", "yusuf demir right wing handball galatasaray turkey goals speed"],
  ["p_14", "James Okafor", "Football", "Goalkeeper (GK)", "Enugu Rangers", "Nigeria", 1050000, true, 13, 24, 194, "Right", "Pro", "james okafor goalkeeper football nigeria reflexes shot stopping crosses"]
];

function ensureSeeded() {
  const store = db.get();
  if (store.seeded) return;

  const now = new Date().toISOString();

  P.forEach((row) => {
    store.players.push({
      id: row[0],
      userId: null,
      name: row[1],
      sport: row[2],
      position: row[3],
      currentClub: row[4],
      country: row[5],
      available: row[7],
      postedDays: row[8],
      age: row[9],
      height: row[10],
      foot: row[11],
      level: row[12],
      keywords: row[13],
      bio: "",
      verified: true,
      rating: 0,
      reviews: 0,
      createdAt: now
    });
  });

  store.clubs.push(
    { id: "c_1", userId: null, name: "Al Ahly SC", sport: "Football", type: "Professional club", country: "Egypt", city: "Cairo", founded: 1907, league: "Egyptian Premier League", verified: true, createdAt: now },
    { id: "c_2", userId: null, name: "SL Benfica", sport: "Football", type: "Professional club", country: "Portugal", city: "Lisbon", founded: 1904, league: "Primeira Liga", verified: true, createdAt: now },
    { id: "c_3", userId: null, name: "KK Split", sport: "Basketball", type: "Professional club", country: "Croatia", city: "Split", founded: 1948, league: "HT Premijer", verified: true, createdAt: now },
    { id: "c_4", userId: null, name: "AZS Warszawa", sport: "Volleyball", type: "Academy", country: "Poland", city: "Warsaw", founded: 1998, league: "PlusLiga", verified: true, createdAt: now },
    { id: "c_5", userId: null, name: "Egyptian Federation", sport: "Karate", type: "National federation", country: "Egypt", city: "Cairo", founded: 1975, league: "WKF", verified: true, createdAt: now }
  );

  // Demo accounts were removed — the board players/clubs above are content
  // only (userId stays null) and real accounts come from registration.

  store.seeded = true;
  // keep the auto-increment counters above the seeded ids so new records never collide
  store.counters.user = 0;
  store.counters.player = 14;
  store.counters.club = 5;
  store.counters.message = 0;
  store.counters.application = 0;
  store.counters.upload = 0;
  db.save();
}

// Admin account used to review registration requests. Idempotent — safe to
// call on every boot. Credentials: admin@manara.app / ADMIN_PASSWORD (from
// .env). In production a missing ADMIN_PASSWORD refuses to boot (same policy
// as JWT_SECRET); in development the "admin123" fallback keeps local work
// running and logs a warning.
function ensureAdmin() {
  let adminPassword = process.env.ADMIN_PASSWORD;
  if (!adminPassword) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("ADMIN_PASSWORD environment variable is required in production");
    }
    console.warn("  WARNING: no ADMIN_PASSWORD set — using development fallback 'admin123'");
    adminPassword = "admin123";
  }
  const store = db.get();
  const existing = store.users.find((u) => u.email === "admin@manara.app");
  if (existing) {
    if (!bcrypt.compareSync(adminPassword, existing.passwordHash)) {
      existing.passwordHash = bcrypt.hashSync(adminPassword, 10);
      db.save();
      console.log("  Updated admin password from env");
    }
    return;
  }
  const hash = bcrypt.hashSync(adminPassword, 10);
  store.users.push({
    id: "u_" + db.nextId("user"),
    role: "admin",
    email: "admin@manara.app",
    name: "Admin",
    passwordHash: hash,
    approved: true,
    createdAt: new Date().toISOString()
  });
  db.save();
  console.log("  Created admin account: admin@manara.app");
}

module.exports = { ensureSeeded, ensureAdmin };