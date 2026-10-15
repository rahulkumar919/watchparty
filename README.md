# YouTube Watch Party System

A real-time collaborative YouTube viewing platform with Socket.IO synchronization and role-based access control.

## Live Demo

**Frontend**: (Update with Vercel URL after deployment)
**Backend**: https://watchpartybacked.onrender.com

## Features

- Real-time video synchronization across all participants
- Room-based system with unique 8-character codes
- YouTube video integration
- WebSocket communication via Socket.IO
- Three-tier role system (Host, Moderator, Participant)
- Request/approval workflow for participants
- Real-time chat
- Drift correction for playback sync

## Role System

| Feature | Host | Moderator | Participant |
|---------|------|-----------|-------------|
| Watch video | Yes | Yes | Yes |
| Play/Pause | Direct | Direct | Request only |
| Seek video | Direct | Direct | Request only |
| Change video | Direct | Direct | Request only |
| Approve/Reject | Yes | Yes | No |
| Promote roles | Yes | No | No |
| Remove users | Yes | No | No |
