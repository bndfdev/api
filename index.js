// ...existing code...
require('dotenv').config();
// ...existing code...
// Genre routes (must be after app is initialized)
const genreRoutes = require('./routes/genre');
const mongoose = require('mongoose');
// Connect to MongoDB
mongoose.connect(process.env.MONGODB_URI);
const db = mongoose.connection;
db.on('error', console.error.bind(console, 'MongoDB connection error:'));
db.once('open', () => {
  console.log('Connected to MongoDB');
});


const express = require('express');
const app = express();
const path = require('path');
const port = process.env.PORT || 3000;
app.use(express.json());
const cors = require('cors');

// CORS configuration to fix CORS issues
const corsOptions = {
  origin: function (origin, callback) {
    const allowedOrigins = [
      'http://localhost:3000',
      'http://localhost:8080',
      'http://localhost:3001',
      'http://localhost:4000',
      'http://localhost:5173',
      'http://127.0.0.1:3000',
      'http://127.0.0.1:8080',
      'http://3.10.42.32:3000',
      'https://3.10.42.32:3000',
      'http://3.10.42.32',
      'https://3.10.42.32',
      // Add your frontend domain here if deployed
    ];
    
    // Allow requests with no origin (like mobile apps, curl requests)
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(null, true); // For development, allow all. Change to false for production security
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key'],
  optionsSuccessStatus: 200
};

app.use(cors(corsOptions));

// Handle preflight requests
app.options('*', cors(corsOptions));

// Serve uploaded files from API public directory
app.use('/uploads', express.static(path.join(__dirname, 'public/uploads')));

// Also serve uploads from admin-panel for backward compatibility
app.use('/uploads', express.static(path.join(__dirname, '../admin-panel/public/uploads')));

// User routes
const userRoutes = require('./routes/user');
app.use('/user', userRoutes);

// Artist routes
const artistRoutes = require('./routes/artist');
app.use('/', artistRoutes);

// Genre routes
app.use('/', genreRoutes);

// Country routes
const countryRoutes = require('./routes/country');
app.use('/countries', countryRoutes);

// Recording routes
const recordingRoutes = require('./routes/recordingRoutes');
app.use('/', recordingRoutes);

// Published audio routes
const publishedAudioRoutes = require('./routes/publishedAudio');
app.use('/', publishedAudioRoutes);

// Basic route
app.get('/', (req, res) => {
  res.send('Bondfire API is running');
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok',
    message: 'API is healthy',
    timestamp: new Date().toISOString()
  });
});


/**
 * @swagger
 * /users:
 *   get:
 *     summary: Get all users
 *     description: Returns a list of all users (placeholder).
 *     tags:
 *       - User
 *     responses:
 *       200:
 *         description: List of users
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 */
app.get('/users', (req, res) => {
  res.json({ message: 'List users - placeholder' });
});


// Swagger UI and swagger-jsdoc setup
const swaggerUi = require('swagger-ui-express');
const swaggerJsdoc = require('swagger-jsdoc');

// Get the server URL from environment or default to localhost
const serverUrl = process.env.API_BASE_URL || `http://localhost:${port}`;

const swaggerOptions = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Bondfire API',
      version: '1.0.0',
      description: 'API documentation for Bondfire',
    },
    servers: [
      {
        url: serverUrl,
        description: 'API Server',
      },
    ],
    components: {
      securitySchemes: {
        ApiKeyAuth: {
          type: 'apiKey',
          in: 'header',
          name: 'x-api-key',
        },
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'verificationToken',
          description: 'Enter the verificationToken value stored in SharedPreferences',
        },
      },
    },
    security: [
      { ApiKeyAuth: [] }
    ],
  },
  apis: ['./routes/*.js'], // Path to the API docs
};

const swaggerSpec = swaggerJsdoc(swaggerOptions);
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));

app.listen(port, () => {
  console.log(`Bondfire API listening at http://localhost:${port}`);
});
