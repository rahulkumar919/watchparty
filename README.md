# YouTube Watch Party System

A real-time collaborative YouTube viewing platform with Socket.IO synchronization and role-based access control.

## Live Demo

Frontend: https://watchparty-qzjv.vercel.app
Backend: https://watchpartybacked.onrender.com
Health: https://watchpartybacked.onrender.com/health

## Features
- Real-time video synchronization
- Three-tier role system (Host, Moderator, Participant)
- Request/approval workflow
- Room-based system with unique codes
- WebSocket communication via Socket.IO
- JWT authentication
- Real-time chat

See ARCHITECTURE.md for technical details.

## Quick Start

git clone https://github.com/rahulkumar919/watchparty.git
cd watchparty
npm install
npm run db:generate --workspace=apps/server
npm run db:migrate --workspace=apps/server
npm run dev --workspace=apps/server
npm run dev --workspace=apps/web

## Tech Stack
Frontend: Next.js 16, TypeScript, Socket.IO Client
Backend: Node.js, Express, Socket.IO, Prisma, PostgreSQL

## Contact
Developer: Rahul Kumar
Email: rahulkumar9508548671@gmail.com
GitHub: @rahulkumar919


## Application Flow

HOME PAGE → Create Room OR Join Room
    │                      │
    ├─ Create Room        ├─ Join Room
    │  (Become Host)      │  (Validate Code)
    │                     │
    └─────────┬───────────┘
              │
              ▼
        Watch Room Page
        (WebSocket Connected)
              │
              ▼
         Check Role
         /         \
    HOST/MOD    PARTICIPANT
        │            │
    Direct      Request
    Control     Workflow
        │            │
        └─────┬──────┘
              │
              ▼
    Backend Validates
              │
              ▼
    Broadcast to All



