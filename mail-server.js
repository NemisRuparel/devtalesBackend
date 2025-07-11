const express = require('express');
const nodemailer = require('nodemailer');
const cors = require('cors');
const app = express();

app.use(cors({ origin: '*' }));
app.use(express.json());

const otpStore = new Map();

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: 'nemisruparel07@gmail.com',
    pass: 'dxnbpzymfyrtchuv',
  },
});

const generateOtp = () => {
  return Math.floor(100000 + Math.random() * 900000).toString();
};

app.post('/send-otp', (req, res) => {
  const { email } = req.body;
  const otp = generateOtp();
  otpStore.set(email, { otp, expires: Date.now() + 5 * 60 * 1000 }); // 5 minutes expiry

  const mailOptions = {
    from: 'nemisruparel07@gmail.com',
    to: email,
    subject: 'Your OTP for Account Verification',
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background-color: #f4f4f4;">
        <h2 style="color: #FF9933;">Account Verification</h2>
        <p>Dear User,</p>
        <p>Thank you for registering with us. Please use the following One-Time Password (OTP) to verify your account:</p>
        <h3 style="color: #138808; font-weight: bold;">${otp}</h3>
        <p>This OTP is valid for 5 minutes. Please do not share it with anyone.</p>
        <p>Best regards,<br>Your Company Name</p>
      </div>
    `,
  };

  transporter.sendMail(mailOptions, (error) => {
    if (error) {
      return res.status(500).json({ success: false, error: 'Failed to send OTP' });
    }
    res.json({ success: true });
  });
});

app.post('/verify-otp', (req, res) => {
  const { email, otp } = req.body;
  const stored = otpStore.get(email);

  if (!stored) {
    return res.status(400).json({ success: false, error: 'No OTP found for this email' });
  }

  if (Date.now() > stored.expires) {
    otpStore.delete(email);
    return res.status(400).json({ success: false, error: 'OTP expired' });
  }

  if (stored.otp === otp) {
    otpStore.delete(email);
    return res.json({ success: true });
  }

  res.status(400).json({ success: false, error: 'Invalid OTP' });
});

app.listen(3000, () => console.log('Server running on port 3000'));