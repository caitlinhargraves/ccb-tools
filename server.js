const express = require('express');
const cron = require('node-cron');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const MONDAY_API_KEY = process.env.MONDAY_API_KEY || 'eyJhbGciOiJIUzI1NiJ9.eyJ0aWQiOjY0OTQ0NjE4NywiYWFpIjoxMSwidWlkIjoxMDE3MTA4NjgsImlhZCI6IjIwMjYtMDQtMjNUMTU6Mzc6MTkuMDAwWiIsInBlciI6Im1lOndyaXRlIiwiYWN0aWQiOjM0NDk0MDk3LCJyZ24iOiJ1c2UxIn0.6FPYgwwTj-05GWXHxxq5lSstcJTGfVOqATNhk5FQBic';
const ORDERS_BOARD_ID = '18407165363';
const SUBITEMS_BOARD_ID = '18407165552';

// Cache
let cache = {
  orders: [],
  lastUpdated: null,
  isLoading: false
};

// Serve static HTML files
app.use(express.static(path.join(__dirname)));
app.use(express.json());

// CORS so all your pages can call this API
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  next();
});

// Fetch from Monday
async function fetchFromMonday() {
  if (cache.isLoading) return;
  cache.isLoading = true;
  console.log('Fetching from Monday...', new Date().toISOString());

  try {
    const query = `{
      boards(ids: [${ORDERS_BOARD_ID}]) {
        items_page(limit: 100) {
          items {
            id
            name
            created_at
            updated_at
            column_values {
              id
              text
              value
            }
            group { id }
            subitems {
              id
              name
              column_values {
                id
                text
                value
              }
            }
          }
        }
      }
    }`;

    const response = await fetch('https://api.monday.com/v2', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': MONDAY_API_KEY,
        'API-Version': '2024-01'
      },
      body: JSON.stringify({ query })
    });

    const data = await response.json();

    if (data.errors) {
      console.error('Monday API errors:', data.errors);
      cache.isLoading = false;
      return;
    }

    cache.orders = data.data.boards[0].items_page.items;
    cache.lastUpdated = new Date().toISOString();
    console.log(`Cache updated: ${cache.orders.length} orders`);

  } catch (err) {
    console.error('Fetch error:', err);
  }

  cache.isLoading = false;
}

// API endpoints
app.get('/api/orders', (req, res) => {
  res.json({
    orders: cache.orders,
    lastUpdated: cache.lastUpdated,
    count: cache.orders.length
  });
});

app.get('/api/refresh', async (req, res) => {
  await fetchFromMonday();
  res.json({
    success: true,
    lastUpdated: cache.lastUpdated,
    count: cache.orders.length
  });
});

// Schedule: 4am - 8pm CT (10am - 2am UTC)
// Runs every minute between those hours
cron.schedule('* 10-23 * * *', fetchFromMonday); // 10am-midnight UTC (4am-6pm CT)
cron.schedule('* 0-2 * * *', fetchFromMonday);   // midnight-2am UTC (6pm-8pm CT)

// Initial fetch on startup
fetchFromMonday();

app.listen(PORT, () => {
  console.log(`CCB Tools server running on port ${PORT}`);
});