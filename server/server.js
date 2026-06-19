require('dotenv').config({ path: '../.env' });
const express = require('express');
const cors = require('cors');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const { pool, query, withTransaction, initDb } = require('./db');
const { isAuthenticated } = require('./middleware/auth');
const { isAdmin } = require('./middleware/admin');

['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'SESSION_SECRET', 'DATABASE_URL'].forEach((k) => {
  if (!process.env[k]) {
    console.error(`FATAL: ${k} is not set in .env`);
    process.exit(1);
  }
});

const CLIENT_URL = process.env.CLIENT_URL || 'http://localhost:5173';
const isProd = process.env.NODE_ENV === 'production';

const app = express();

// Required for secure cookies behind Railway's HTTPS proxy.
app.set('trust proxy', 1);

app.use(
  cors({
    origin: CLIENT_URL,
    credentials: true,
  })
);

app.use(express.json());

app.use(
  session({
    store: new PgSession({
      pool,
      tableName: 'session',
      createTableIfMissing: true,
    }),
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: isProd,
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    },
  })
);

app.use(passport.initialize());
app.use(passport.session());

passport.serializeUser((user, done) => {
  done(null, user.id);
});

passport.deserializeUser(async (id, done) => {
  try {
    const result = await query('SELECT * FROM users WHERE id = $1', [id]);
    done(null, result.rows[0] || false);
  } catch (err) {
    done(err);
  }
});

passport.use(
  new GoogleStrategy(
    {
      clientID: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL: `${process.env.SERVER_URL || 'http://localhost:3001'}/api/auth/google/callback`,
    },
    async (accessToken, refreshToken, profile, done) => {
      try {
        const googleId = profile.id;
        const email = profile.emails?.[0]?.value || '';
        const name = profile.displayName || '';
        const avatarUrl = profile.photos?.[0]?.value || '';

        let userRow = (await query('SELECT * FROM users WHERE google_id = $1', [googleId])).rows[0];

        if (!userRow) {
          // Atomic: create user + default profile together.
          const newUserId = await withTransaction(async (client) => {
            const res = await client.query(
              'INSERT INTO users (google_id, email, name, avatar_url) VALUES ($1, $2, $3, $4) RETURNING id',
              [googleId, email, name, avatarUrl]
            );
            const uid = res.rows[0].id;
            await client.query(
              `INSERT INTO player_profile (user_id, computed_level, profile_updated_at)
               VALUES ($1, 'intermediate', NOW())`,
              [uid]
            );
            return uid;
          });
          userRow = (await query('SELECT * FROM users WHERE id = $1', [newUserId])).rows[0];
        } else {
          // Refresh name + avatar from Google.
          await query(
            'UPDATE users SET email = $1, name = $2, avatar_url = $3 WHERE id = $4',
            [email, name, avatarUrl, userRow.id]
          );
          userRow = (await query('SELECT * FROM users WHERE id = $1', [userRow.id])).rows[0];

          // Backfill profile if somehow missing.
          const existingProfile = (await query('SELECT id FROM player_profile WHERE user_id = $1', [userRow.id])).rows[0];
          if (!existingProfile) {
            await query(
              `INSERT INTO player_profile (user_id, computed_level, profile_updated_at)
               VALUES ($1, 'intermediate', NOW())`,
              [userRow.id]
            );
          }
        }

        // Admin seeding via ADMIN_EMAIL. Only path to admin at launch.
        const adminEmail = process.env.ADMIN_EMAIL?.toLowerCase();
        const userEmail = (userRow.email || '').toLowerCase();
        if (adminEmail && userEmail === adminEmail && userRow.role !== 'admin') {
          await query('UPDATE users SET role = $1 WHERE id = $2', ['admin', userRow.id]);
          userRow = (await query('SELECT * FROM users WHERE id = $1', [userRow.id])).rows[0];
          console.log(`Granted admin role to ${userRow.email} (user ${userRow.id})`);
        }

        done(null, userRow);
      } catch (err) {
        done(err);
      }
    }
  )
);

app.use('/api/auth', require('./routes/auth'));
app.use('/api/principles', require('./routes/principles'));

app.use('/api/games', isAuthenticated, require('./routes/games'));
app.use('/api/coach', isAuthenticated, require('./routes/coach'));
app.use('/api/profile', isAuthenticated, require('./routes/profile'));
app.use('/api/admin', isAuthenticated, isAdmin, require('./routes/admin'));

const PORT = process.env.PORT || 3001;

initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Chess Coach server running on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Database init failed:', err);
    process.exit(1);
  });
