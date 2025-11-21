const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

app.use(cors({
  origin: ['https://referraldashboard-bqvu.onrender.com', 'http://localhost:5000'],
  credentials: true
}));
app.use(express.json());

function generateReferralCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

async function getUniqueReferralCode() {
  let code;
  let exists = true;
  while (exists) {
    code = generateReferralCode();
    const result = await pool.query('SELECT id FROM users WHERE referral_code = $1', [code]);
    exists = result.rows.length > 0;
  }
  return code;
}

async function buildReferralTree(userId, visited = new Set()) {
  if (visited.has(userId)) return null;
  visited.add(userId);

  const userResult = await pool.query(
    'SELECT id, referred_by FROM users WHERE id = $1',
    [userId]
  );
  
  if (userResult.rows.length === 0) return null;
  
  const user = userResult.rows[0];
  const tree = [];
  
  if (user.referred_by) {
    const level1 = await pool.query('SELECT id FROM users WHERE id = $1', [user.referred_by]);
    if (level1.rows.length > 0) {
      tree.push({ userId: user.referred_by, level: 1 });
      
      const level1User = await pool.query('SELECT referred_by FROM users WHERE id = $1', [user.referred_by]);
      if (level1User.rows[0].referred_by) {
        const level2 = await pool.query('SELECT id FROM users WHERE id = $1', [level1User.rows[0].referred_by]);
        if (level2.rows.length > 0 && !visited.has(level2.rows[0].id)) {
          tree.push({ userId: level2.rows[0].id, level: 2 });
          
          const level2User = await pool.query('SELECT referred_by FROM users WHERE id = $1', [level2.rows[0].id]);
          if (level2User.rows[0].referred_by && !visited.has(level2User.rows[0].referred_by)) {
            tree.push({ userId: level2User.rows[0].referred_by, level: 3 });
          }
        }
      }
    }
  }
  
  return tree;
}

app.post('/api/register', async (req, res) => {
  const client = await pool.connect();
  try {
    const { email, referralCode } = req.body;
    
    if (!email || !email.match(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)) {
      return res.status(400).json({ error: 'Valid email is required' });
    }

    await client.query('BEGIN');

    const existingUser = await client.query('SELECT id FROM users WHERE email = $1', [email]);
    if (existingUser.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Email already registered' });
    }

    let referrerId = null;
    if (referralCode) {
      const referrer = await client.query('SELECT id FROM users WHERE referral_code = $1', [referralCode]);
      if (referrer.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Invalid referral code' });
      }
      referrerId = referrer.rows[0].id;
    }

    const newReferralCode = await getUniqueReferralCode();
    
    const userResult = await client.query(
      'INSERT INTO users (email, referral_code, referred_by, created_at, total_deposits, total_earnings) VALUES ($1, $2, $3, CURRENT_DATE, 0, 0) RETURNING id, email, referral_code',
      [email, newReferralCode, referrerId]
    );

    const newUser = userResult.rows[0];

    if (referrerId) {
      const ancestors = await buildReferralTree(newUser.id);
      if (ancestors) {
        for (const ancestor of ancestors) {
          await client.query(
            'INSERT INTO referrals (referrer_id, referred_id, level, created_at) VALUES ($1, $2, $3, CURRENT_DATE)',
            [ancestor.userId, newUser.id, ancestor.level]
          );
        }
      }
    }

    await client.query('COMMIT');

    res.json({
      success: true,
      user: {
        id: newUser.id,
        email: newUser.email,
        referralCode: newUser.referral_code,
        referralLink: `https://nvidiaai.bet/register?ref=${newUser.referral_code}`
      }
    });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Registration failed' });
  } finally {
    client.release();
  }
});

app.get('/api/user/:email', async (req, res) => {
  try {
    const { email } = req.params;
    
    const userResult = await pool.query(
      'SELECT id, email, referral_code, total_deposits, total_earnings FROM users WHERE email = $1',
      [email]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = userResult.rows[0];
    
    const referralsResult = await pool.query(
      `SELECT r.level, u.email as referred_email, u.total_deposits, r.created_at 
       FROM referrals r 
       JOIN users u ON r.referred_id = u.id 
       WHERE r.referrer_id = $1 
       ORDER BY r.level, r.created_at DESC`,
      [user.id]
    );

    const rewardsResult = await pool.query(
      `SELECT r.*, u.email as from_email 
       FROM rewards r 
       JOIN users u ON r.from_user_id = u.id 
       WHERE r.user_id = $1 
       ORDER BY r.created_at DESC`,
      [user.id]
    );

    const pendingRewards = rewardsResult.rows
      .filter(r => !r.claimed)
      .reduce((sum, r) => sum + parseFloat(r.reward_amount.replace('$', '')), 0);

    res.json({
      user: {
        id: user.id,
        email: user.email,
        referralCode: user.referral_code,
        referralLink: `https://nvidiaai.bet/register?ref=${user.referral_code}`,
        totalDeposits: user.total_deposits,
        totalEarnings: user.total_earnings,
        pendingRewards: pendingRewards.toFixed(2)
      },
      referrals: referralsResult.rows,
      rewards: rewardsResult.rows
    });

  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ error: 'Failed to fetch user data' });
  }
});

app.post('/api/deposit', async (req, res) => {
  const client = await pool.connect();
  try {
    const { email, amount } = req.body;

    if (!email || !amount || amount <= 0) {
      return res.status(400).json({ error: 'Valid email and amount required' });
    }

    await client.query('BEGIN');

    const userResult = await client.query('SELECT id FROM users WHERE email = $1', [email]);
    if (userResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'User not found' });
    }

    const userId = userResult.rows[0].id;

    const depositResult = await client.query(
      'INSERT INTO deposits (user_id, amount, created_at) VALUES ($1, $2, CURRENT_DATE) RETURNING id',
      [userId, amount]
    );

    await client.query(
      'UPDATE users SET total_deposits = total_deposits + $1 WHERE id = $2',
      [amount, userId]
    );

    const referrersResult = await client.query(
      'SELECT referrer_id, level FROM referrals WHERE referred_id = $1',
      [userId]
    );

    const rewardLevels = await client.query(
      'SELECT level, percentage FROM reward_levels ORDER BY level'
    );

    const rewardMap = {};
    rewardLevels.rows.forEach(rl => {
      rewardMap[rl.level] = rl.percentage;
    });

    for (const ref of referrersResult.rows) {
      const percentage = rewardMap[ref.level] || 0;
      const rewardAmount = (amount * percentage) / 100;

      await client.query(
        'INSERT INTO rewards (user_id, from_user_id, level, deposit_amount, reward_amount, created_at, claimed) VALUES ($1, $2, $3, $4, $5, CURRENT_DATE, FALSE)',
        [ref.referrer_id, userId, ref.level, amount, rewardAmount]
      );
    }

    await client.query('COMMIT');

    res.json({
      success: true,
      message: 'Deposit recorded and rewards calculated'
    });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Deposit error:', error);
    res.status(500).json({ error: 'Deposit failed' });
  } finally {
    client.release();
  }
});

app.post('/api/rewards/claim', async (req, res) => {
  const client = await pool.connect();
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'Email required' });
    }

    await client.query('BEGIN');

    const userResult = await client.query('SELECT id, total_earnings FROM users WHERE email = $1', [email]);
    if (userResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'User not found' });
    }

    const userId = userResult.rows[0].id;

    const pendingRewards = await client.query(
      'SELECT id, reward_amount FROM rewards WHERE user_id = $1 AND claimed = FALSE',
      [userId]
    );

    if (pendingRewards.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'No pending rewards to claim' });
    }

    let totalClaimed = 0;
    for (const reward of pendingRewards.rows) {
      const amount = parseFloat(reward.reward_amount.replace('$', ''));
      totalClaimed += amount;
      await client.query('UPDATE rewards SET claimed = TRUE WHERE id = $1', [reward.id]);
    }

    await client.query(
      'UPDATE users SET total_earnings = total_earnings + $1 WHERE id = $2',
      [totalClaimed, userId]
    );

    await client.query('COMMIT');

    res.json({
      success: true,
      claimedAmount: totalClaimed.toFixed(2),
      message: 'Rewards claimed successfully'
    });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Claim rewards error:', error);
    res.status(500).json({ error: 'Failed to claim rewards' });
  } finally {
    client.release();
  }
});

app.get('/api/stats', async (req, res) => {
  try {
    const stats = await pool.query(`
      SELECT 
        COUNT(DISTINCT u.id) as total_users,
        COUNT(DISTINCT d.id) as total_deposits,
        SUM(CAST(d.amount AS NUMERIC)) as total_deposit_amount,
        COUNT(DISTINCT r.id) as total_rewards
      FROM users u
      LEFT JOIN deposits d ON u.id = d.user_id
      LEFT JOIN rewards r ON u.id = r.user_id
    `);

    res.json(stats.rows[0]);
  } catch (error) {
    console.error('Stats error:', error);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Referral system server running on port ${PORT}`);
});
