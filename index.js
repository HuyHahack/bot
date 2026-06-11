const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const axios = require('axios');
const express = require('express');
const db = require('./database');
require('dotenv/config');

// ============ EXPRESS SERVER CHO HEALTH CHECK ============
const app = express();
app.use(express.json());

app.get('/', (req, res) => {
  res.json({ 
    status: 'online', 
    bot: client?.user?.tag || 'starting',
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🌐 Web server chạy tại cổng ${PORT}`);
});

// ============ DISCORD BOT ============
const client = new Client({ 
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessages
  ] 
});

// Lưu giao dịch đang chờ (dùng Map nhưng có giới hạn)
const pendingPayments = new Map();
const MAX_PENDING = 100;

// Xóa giao dịch cũ mỗi phút
setInterval(() => {
  const now = Date.now();
  for (const [code, payment] of pendingPayments) {
    if (now - payment.timestamp > 15 * 60 * 1000) { // 15 phút
      pendingPayments.delete(code);
    }
  }
}, 60000);

// Định nghĩa lệnh slash
const commands = [
  new SlashCommandBuilder()
    .setName('nap')
    .setDescription('Nạp tiền vào tài khoản ảo')
    .addIntegerOption(option => 
      option.setName('sotien')
        .setDescription('Số tiền cần nạp (VNĐ)')
        .setRequired(true)
        .setMinValue(2000)
        .setMaxValue(5000000)),
  
  new SlashCommandBuilder()
    .setName('sodu')
    .setDescription('Kiểm tra số dư tài khoản ảo'),
  
  new SlashCommandBuilder()
    .setName('top')
    .setDescription('Xem top 10 người dùng giàu nhất'),
  
  new SlashCommandBuilder()
    .setName('buy')
    .setDescription('Mua hàng (demo)')
    .addStringOption(option =>
      option.setName('item')
        .setDescription('Sản phẩm muốn mua')
        .setRequired(true)
        .addChoices(
          { name: 'VIP 1 tháng', value: 'vip1' },
          { name: 'VIP 3 tháng', value: 'vip3' },
          { name: 'Role Đặc Biệt', value: 'role' }
        )),
  
  new SlashCommandBuilder()
    .setName('help')
    .setDescription('Xem hướng dẫn sử dụng bot')
];

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

client.once('ready', async () => {
  console.log(`✅ Bot đã đăng nhập: ${client.user.tag}`);
  console.log(`⏰ Uptime: ${new Date().toISOString()}`);
  
  try {
    await rest.put(Routes.applicationCommands(client.user.id), { 
      body: commands.map(cmd => cmd.toJSON()) 
    });
    console.log('✅ Đã đăng ký slash commands!');
  } catch (error) {
    console.error('❌ Lỗi đăng ký lệnh:', error);
  }
});

// Hàm kiểm tra thanh toán PayOS
async function checkPaymentStatus(orderCode) {
  try {
    const response = await axios.get(`https://api.payos.vn/v1/payment-requests/${orderCode}`, {
      headers: {
        'x-client-id': process.env.PAYOS_CLIENT_ID,
        'x-api-key': process.env.PAYOS_API_KEY,
        'x-checksum-key': process.env.PAYOS_CHECKSUM_KEY
      },
      timeout: 10000
    });
    return response.data.data;
  } catch (error) {
    console.error(`Check payment ${orderCode} error:`, error.message);
    return null;
  }
}

// Hàm tạo payment link
async function createPaymentLink(orderCode, amount, description, userId, username) {
  try {
    const response = await axios.post('https://api.payos.vn/v1/payment-requests', {
      orderCode: orderCode,
      amount: amount,
      description: description,
      returnUrl: `https://discord.com/users/${userId}`,
      cancelUrl: `https://discord.com/users/${userId}`,
      buyerName: username,
      buyerEmail: `${userId}@discord.user`,
      expiredAt: Math.floor(Date.now() / 1000) + 600
    }, {
      headers: {
        'x-client-id': process.env.PAYOS_CLIENT_ID,
        'x-api-key': process.env.PAYOS_API_KEY,
        'x-checksum-key': process.env.PAYOS_CHECKSUM_KEY,
        'Content-Type': 'application/json'
      },
      timeout: 15000
    });
    
    return response.data.data;
  } catch (error) {
    console.error('Create payment error:', error.response?.data || error.message);
    throw error;
  }
}

// Kiểm tra thanh toán định kỳ (mỗi 15 giây)
setInterval(async () => {
  if (pendingPayments.size === 0) return;
  
  console.log(`🔄 Đang kiểm tra ${pendingPayments.size} giao dịch...`);
  
  for (const [orderCode, payment] of pendingPayments) {
    const paymentData = await checkPaymentStatus(orderCode);
    
    if (paymentData && paymentData.status === 'PAID') {
      const success = await db.addBalance(payment.userId, payment.amount, orderCode);
      
      if (success) {
        console.log(`✅ Đã cộng ${payment.amount.toLocaleString()} VND cho user ${payment.userId}`);
        
        // Thông báo cho user
        const user = await client.users.fetch(payment.userId).catch(() => null);
        if (user) {
          const embed = new EmbedBuilder()
            .setColor(0x00FF00)
            .setTitle('✅ NẠP TIỀN THÀNH CÔNG!')
            .setDescription(`Số tiền **${payment.amount.toLocaleString()} VND** đã được cộng vào tài khoản.`)
            .addFields(
              { name: '💰 Số dư mới', value: `${(await db.getBalance(payment.userId)).toLocaleString()} VND`, inline: true },
              { name: '💳 Mã GD', value: `\`${orderCode}\``, inline: true }
            )
            .setTimestamp();
          
          await user.send({ embeds: [embed] }).catch(() => null);
        }
        
        pendingPayments.delete(orderCode);
      }
    }
  }
}, 15000);

// ============ DISCORD COMMANDS ============
client.on('interactionCreate', async interaction => {
  if (!interaction.isCommand()) return;

  // /sodu
  if (interaction.commandName === 'sodu') {
    const balance = await db.getBalance(interaction.user.id);
    const embed = new EmbedBuilder()
      .setColor(0x00FF00)
      .setTitle('💰 SỐ DƯ TÀI KHOẢN')
      .setDescription(`**${balance.toLocaleString()} VND**`)
      .setFooter({ text: interaction.user.tag })
      .setTimestamp();
    
    await interaction.reply({ embeds: [embed] });
  }

  // /top
  if (interaction.commandName === 'top') {
    const topUsers = await db.getTopUsers(10);
    if (topUsers.length === 0) {
      return interaction.reply('📊 Chưa có dữ liệu người dùng!');
    }
    
    let description = '';
    for (let i = 0; i < topUsers.length; i++) {
      const user = await client.users.fetch(topUsers[i].user_id).catch(() => null);
      const name = user ? user.username : `User ${topUsers[i].user_id.slice(-6)}`;
      description += `${i + 1}. **${name}** - ${topUsers[i].balance.toLocaleString()} VND\n`;
    }
    
    const embed = new EmbedBuilder()
      .setColor(0xFFD700)
      .setTitle('🏆 TOP 10 NGƯỜI GIÀU NHẤT')
      .setDescription(description)
      .setTimestamp();
    
    await interaction.reply({ embeds: [embed] });
  }

  // /buy
  if (interaction.commandName === 'buy') {
    const item = interaction.options.getString('item');
    const prices = { vip1: 50000, vip3: 120000, role: 100000 };
    const price = prices[item];
    
    const balance = await db.getBalance(interaction.user.id);
    
    if (balance < price) {
      return interaction.reply({ 
        content: `⚠️ Bạn không đủ tiền! Cần **${price.toLocaleString()} VND**, bạn có **${balance.toLocaleString()} VND**`,
        ephemeral: true 
      });
    }
    
    const success = await db.deductBalance(interaction.user.id, price);
    
    if (success) {
      const newBalance = await db.getBalance(interaction.user.id);
      const embed = new EmbedBuilder()
        .setColor(0x00FF00)
        .setTitle('✅ MUA HÀNG THÀNH CÔNG!')
        .addFields(
          { name: '🛒 Sản phẩm', value: item, inline: true },
          { name: '💰 Giá', value: `${price.toLocaleString()} VND`, inline: true },
          { name: '💎 Số dư còn lại', value: `${newBalance.toLocaleString()} VND`, inline: true }
        )
        .setTimestamp();
      
      await interaction.reply({ embeds: [embed] });
    } else {
      await interaction.reply({ content: '❌ Giao dịch thất bại!', ephemeral: true });
    }
  }

  // /nap
  if (interaction.commandName === 'nap') {
    const amount = interaction.options.getInteger('sotien');
    
    if (amount < 2000) {
      return interaction.reply({ 
        content: '⚠️ Số tiền nạp tối thiểu là **2,000 VND**!', 
        ephemeral: true 
      });
    }

    if (pendingPayments.size >= MAX_PENDING) {
      return interaction.reply({ 
        content: '⚠️ Hệ thống đang quá tải, vui lòng thử lại sau!', 
        ephemeral: true 
      });
    }

    await interaction.reply({ 
      content: `🔄 Đang tạo mã thanh toán ${amount.toLocaleString()} VND...`,
      ephemeral: true
    });

    try {
      const orderCode = Number(Date.now());
      const description = `NAP${interaction.user.id.slice(-8)}`;
      
      const paymentData = await createPaymentLink(
        orderCode, amount, description, interaction.user.id, interaction.user.username
      );
      
      pendingPayments.set(orderCode, {
        userId: interaction.user.id,
        amount: amount,
        timestamp: Date.now()
      });
      
      const embed = new EmbedBuilder()
        .setColor(0xFFA500)
        .setTitle('🧧 NẠP TIỀN')
        .setDescription(`💰 Số tiền: **${amount.toLocaleString()} VND**`)
        .addFields(
          { name: '🔗 LINK THANH TOÁN', value: `[Nhấn vào đây](${paymentData.checkoutUrl})`, inline: false },
          { name: '💳 Mã GD', value: `\`${orderCode}\``, inline: true },
          { name: '📝 Nội dung CK', value: `\`${description}\``, inline: true },
          { name: '⏰ Hết hạn', value: '15 phút', inline: true }
        )
        .setImage(paymentData.qrCode)
        .setFooter({ text: 'Sau khi chuyển khoản, bot sẽ tự cộng tiền trong vòng 30 giây' })
        .setTimestamp();

      await interaction.editReply({ content: null, embeds: [embed] });

    } catch (error) {
      console.error('Nap error:', error);
      await interaction.editReply({ 
        content: '❌ Lỗi tạo link thanh toán. Vui lòng thử lại sau!',
        ephemeral: true
      });
    }
  }

  // /help
  if (interaction.commandName === 'help') {
    const embed = new EmbedBuilder()
      .setColor(0x0099FF)
      .setTitle('🤖 HƯỚNG DẪN SỬ DỤNG')
      .setDescription('Dưới đây là các lệnh có sẵn:')
      .addFields(
        { name: '/nap <số tiền>', value: '💰 Nạp tiền (tối thiểu 2,000 VND)', inline: false },
        { name: '/sodu', value: '💎 Kiểm tra số dư', inline: false },
        { name: '/top', value: '🏆 Top người dùng giàu nhất', inline: false },
        { name: '/buy <item>', value: '🛒 Mua hàng (VIP/Role)', inline: false },
        { name: '/help', value: '❓ Hướng dẫn này', inline: false }
      )
      .setFooter({ text: 'Bot chạy 24/7 trên Render.com' });
    
    await interaction.reply({ embeds: [embed] });
  }
});

// Xử lý lỗi
process.on('unhandledRejection', (error) => {
  console.error('Unhandled rejection:', error);
});

client.login(process.env.DISCORD_TOKEN);