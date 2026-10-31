# 💍 Aumre & Joudy Wedding Quiz

An all-in-one, real-time multiplayer wedding trivia game built specifically for **Aumre & Joudy's Wedding**. Supports 50–100+ guests simultaneously on mobile devices, optimized for free-tier Render deployment.

---

## ⚡ Quick Start (Local)

1. Make sure dependencies are installed:
   ```bash
   npm install
   ```
2. Start the server:
   ```bash
   npm start
   ```
3. Open in your browser:
   - **Host Screen (Projector/TV/Laptop):** [http://localhost:3000/host?pin=1234](http://localhost:3000/host?pin=1234)
   - **Player Screen (Mobile Guest):** [http://localhost:3000/](http://localhost:3000/)

---

## 🚀 2-Minute Deployment to Render

1. **Push this folder to a GitHub repository:**
   ```bash
   git init
   git add .
   git commit -m "Wedding Quiz for Aumre & Joudy"
   # Create a repo on GitHub, then push:
   git branch -M main
   git remote add origin https://github.com/YOUR_USERNAME/aumre-wedding-quiz.git
   git push -u origin main
   ```

2. **Deploy on Render (Free Tier):**
   - Go to [dashboard.render.com](https://dashboard.render.com) and click **New +** > **Web Service**.
   - Connect your GitHub repository.
   - Settings:
     - **Name:** `aumre-wedding-quiz`
     - **Environment:** `Node`
     - **Build Command:** `npm install`
     - **Start Command:** `node server.js`
     - **Instance Type:** `Free`
   - Click **Deploy Web Service**!

3. **Showtime at the Wedding:**
   - Open `https://your-service-name.onrender.com/host?pin=1234` on your projector laptop.
   - The large QR code will automatically point guests to `https://your-service-name.onrender.com/`.
   - Guests point their phone cameras at the screen, tap, enter their names, and they're in!

> 💡 **Pro-Tip for Tonight:** Open the Render URL 5 minutes before the quiz starts so Render's free container is warm and ready for instant guest connections!

---

## 🎮 Host / MC Controls

- **Lobby:** Shows a live QR Code and real-time counter of guests as they join. Click **Start Quiz** when ready.
- **Questions:** 20-second countdown with a live answer ratio (`X / Y Guests Answered`).
- **Reveal:** Shows audience voting split (%) and highlights the official couple answer from the answer key.
- **Leaderboard:** Dynamic top-10 ranking based on speed + accuracy.
- **Final Podium:** Olympic 3-tier podium with confetti fanfare for the 1st, 2nd, and 3rd place winners!

### Keyboard Shortcuts for MC:
- `Spacebar`: Automatically advances to the next logical step (Start -> Reveal -> Leaderboard -> Next Question).
- `F`: Toggle Fullscreen for projector/TV display.
