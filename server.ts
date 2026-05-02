import express from 'express';
import path from 'path';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { createServer as createViteServer } from 'vite';
import { loadEnv } from './config/env';
import { supabase as supabaseAdmin } from './config/supabase';
import apiRoutes from './routes/api.routes';
import './jobs/billing.worker';
import './jobs/webhook.worker';

loadEnv();

async function startServer() {
  const app = express();
  const httpServer = createServer(app);
  const allowedOrigins = process.env.NODE_ENV === 'production'
    ? [process.env.VITE_APP_URL || 'https://yourdomain.com']
    : ['http://localhost:3000', 'http://localhost:5173'];

  const io = new Server(httpServer, {
    cors: {
      origin: allowedOrigins,
      methods: ['GET', 'POST'],
    },
  });

  const PORT = Number(process.env.PORT || 3000);
  const serveFrontend = process.env.SERVE_FRONTEND === 'true';

  app.use(express.json());

  // Attach io to request for use in controllers/middleware if needed
  app.use((req, res, next) => {
    (req as any).io = io;
    next();
  });

  // API Routes
  app.use('/api', apiRoutes);

  // Socket.io connection
  io.use(async (socket, next) => {
    const token = socket.handshake.auth?.token as string | undefined;
    if (!token) return next(new Error('Authentication required'));

    const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);
    if (error || !user) return next(new Error('Invalid or expired token'));

    (socket as any).userId = user.id;
    next();
  });

  io.on('connection', (socket) => {
    const verifiedUserId = (socket as any).userId;

    socket.on('subscribe', (requestedUserId: string) => {
      if (verifiedUserId === requestedUserId) {
        socket.join(`user:${verifiedUserId}`);
      }
      // silently ignore attempts to join other users' rooms
    });

    socket.on('disconnect', () => {
      console.log('Client disconnected:', socket.id);
    });
  });

  if (!serveFrontend) {
    app.get('/', (_req, res) => {
      res.json({
        name: 'MeterFlow API',
        status: 'running',
        port: PORT,
      });
    });

    app.use((_req, res) => {
      res.status(404).json({ error: 'Not found' });
    });
  } else if (process.env.NODE_ENV !== 'production') {
    // Vite middleware for full-stack development
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`MeterFlow Server running on http://localhost:${PORT}`);
  });
}

startServer().catch(console.error);
