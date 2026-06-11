const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const axios = require('axios');
const express = require('express');
const db = require('./database');
require('dotenv/config');

// ============ EXPRESS SERVER ============
const app = express();
app.use(express.json());

app.get('/', (req, res) => {
  res.json({ status: 'online', bot: client?.user?.tag || 'starting', uptime: process.uptime() });
});

app.get('/health', (req, res) => res.status(200).send('OK'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🌐 Web server chạy tại cổng ${PORT}`));

// ============ DISCORD BOT ============
const client = new Client({ 
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMessages] 
});

// Giá sản phẩm
const PRICES = {
  'lv5': 2500,
  'kc7d': 30000,
  'kcvv': 40000
};

// Tên hiển thị
const PRODUCT_NAMES = {
  'lv5': '🎮 Clone Level 5',
  'kc7d': '⚡ Clone Rank KC (7 ngày)',
  'kcvv': '💎 Clone Rank KC (Vĩnh viễn)'
};

// Admin ID (thay bằng ID Discord của bạn)
const ADMIN_IDS = ['1512658477841908015']; // Thay ID của bạn vào đây

// Lưu giao dịch chờ
const pendingPayments = new Map();

// ============ SLASH COMMANDS ============
const commands = [
  new SlashCommandBuilder()
    .setName('start')
    .setDescription('Hiển thị bảng điều khiển (Chỉ admin)'),
  new SlashCommandBuilder()
    .setName('addclone')
    .setDescription('Thêm clone vào kho (Chỉ admin)')
    .addStringOption(option =>
      option.setName('type')
        .setDescription('Loại clone')
        .setRequired(true)
        .addChoices(
          { name: 'Level 5 (2,500đ)', value: 'lv5' },
          { name: 'Rank KC 7 ngày (30,000đ)', value: 'kc7d' },
          { name: 'Rank KC Vĩnh viễn (40,000đ)', value: 'kcvv' }
        ))
    .addStringOption(option =>
      option.setName('email')
        .setDescription('Email đăng nhập')
        .setRequired(true))
    .addStringOption(option =>
      option.setName('password')
        .setDescription('Mật khẩu')
        .setRequired(true))
];

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

client.once('ready', async () => {
  console.log(`✅ Bot đã đăng nhập: ${client.user.tag}`);
  try {
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands.map(cmd => cmd.toJSON()) });
    console.log('✅ Đã đăng ký slash commands!');
  } catch (error) {
    console.error('❌ Lỗi đăng ký lệnh:', error);
  }
});

// ============ HÀM TẠO MENU NÚT ============
function createMainMenu() {
  const row1 = new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder().setCustomId('nap').setLabel('💰 NẠP TIỀN').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('sodu').setLabel('💎 SỐ DƯ').setStyle(ButtonStyle.Primary)
    );
  
  const row2 = new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder().setCustomId('buy_lv5').setLabel('🎮 Level 5 - 2,500đ').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('buy_kc7d').setLabel('⚡ KC 7 ngày - 30,000đ').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('buy_kcvv').setLabel('💎 KC Vĩnh viễn - 40,000đ').setStyle(ButtonStyle.Secondary)
    );
  
  const row3 = new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder().setCustomId('help').setLabel('❓ HƯỚNG DẪN').setStyle(ButtonStyle.Secondary)
    );
  
  return { components: [row1, row2, row3] };
}

// ============ HÀM TẠO MENU NẠP TIỀN ============
function createNapMenu() {
  const row = new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder().setCustomId('nap_5k').setLabel('5,000đ').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('nap_10k').setLabel('10,000đ').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('nap_20k').setLabel('20,000đ').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('nap_50k').setLabel('50,000đ').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('nap_100k').setLabel('100,000đ').setStyle(ButtonStyle.Success)
    );
  
  const row2 = new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder().setCustomId('back_menu').setLabel('◀️ QUAY LẠI').setStyle(ButtonStyle.Danger)
    );
  
  return { components: [row, row2] };
}

// ============ HÀM TẠO PAYMENT LINK ============
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

// ============ KIỂM TRA THANH TOÁN ============
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

// Kiểm tra định kỳ
setInterval(async () => {
  if (pendingPayments.size === 0) return;
  
  for (const [orderCode, payment] of pendingPayments) {
    const paymentData = await checkPaymentStatus(orderCode);
    if (paymentData && paymentData.status === 'PAID') {
      await db.addBalance(payment.userId, payment.amount, orderCode);
      console.log(`✅ Đã cộng ${payment.amount.toLocaleString()} VND cho user ${payment.userId}`);
      
      const user = await client.users.fetch(payment.userId).catch(() => null);
      if (user) {
        const embed = new EmbedBuilder()
          .setColor(0x00FF00)
          .setTitle('✅ NẠP TIỀN THÀNH CÔNG!')
          .setDescription(`Số tiền **${payment.amount.toLocaleString()} VND** đã được cộng.`)
          .addFields({ name: '💰 Số dư mới', value: `${(await db.getBalance(payment.userId)).toLocaleString()} VND` })
          .setTimestamp();
        await user.send({ embeds: [embed] }).catch(() => null);
      }
      pendingPayments.delete(orderCode);
    }
  }
}, 15000);

// ============ XỬ LÝ COMMANDS ============
client.on('interactionCreate', async interaction => {
  if (interaction.isCommand()) {
    // /start - Chỉ admin
    if (interaction.commandName === 'start') {
      if (!ADMIN_IDS.includes(interaction.user.id)) {
        return interaction.reply({ content: '❌ Bạn không có quyền sử dụng lệnh này!', ephemeral: true });
      }
      
      const stats = await db.getAllProductsByType();
      const embed = new EmbedBuilder()
        .setColor(0x00FF00)
        .setTitle('🏪 CỬA HÀNG BÁN CLONE')
        .setDescription('Chào mừng bạn đến với cửa hàng!\n\n📋 **Bảng giá:**\n• 🎮 Clone Level 5: **2,500đ**\n• ⚡ Clone Rank KC (7 ngày): **30,000đ**\n• 💎 Clone Rank KC (Vĩnh viễn): **40,000đ**\n\n📦 **Tồn kho:**\n• Level 5: ${stats.lv5 || 0} cái\n• KC 7 ngày: ${stats.kc7d || 0} cái\n• KC Vĩnh viễn: ${stats.kcvv || 0} cái\n\n⬇️ **Nhấn nút bên dưới để bắt đầu!**')
        .setFooter({ text: 'Mọi thắc mắc liên hệ Admin' })
        .setTimestamp();
      
      await interaction.reply({ embeds: [embed], ...createMainMenu() });
    }
    
    // /addclone - Chỉ admin
    if (interaction.commandName === 'addclone') {
      if (!ADMIN_IDS.includes(interaction.user.id)) {
        return interaction.reply({ content: '❌ Bạn không có quyền!', ephemeral: true });
      }
      
      const type = interaction.options.getString('type');
      const email = interaction.options.getString('email');
      const password = interaction.options.getString('password');
      
      await db.addClone(type, email, password);
      await interaction.reply({ content: `✅ Đã thêm ${PRODUCT_NAMES[type]} thành công!\n📧 Email: ${email}\n🔑 Pass: ${password}`, ephemeral: true });
    }
  }
  
  // Xử lý nút bấm
  if (interaction.isButton()) {
    const userId = interaction.user.id;
    
    // Nút QUAY LẠI
    if (interaction.customId === 'back_menu') {
      const stats = await db.getAllProductsByType();
      const embed = new EmbedBuilder()
        .setColor(0x00FF00)
        .setTitle('🏪 CỬA HÀNG BÁN CLONE')
        .setDescription(`📦 **Tồn kho hiện tại:**\n• Level 5: ${stats.lv5 || 0} cái\n• KC 7 ngày: ${stats.kc7d || 0} cái\n• KC Vĩnh viễn: ${stats.kcvv || 0} cái\n\n⬇️ **Chọn sản phẩm:**`)
        .setTimestamp();
      await interaction.update({ embeds: [embed], ...createMainMenu() });
      return;
    }
    
    // Nút NẠP TIỀN
    if (interaction.customId === 'nap') {
      const embed = new EmbedBuilder()
        .setColor(0xFFA500)
        .setTitle('💰 NẠP TIỀN')
        .setDescription('Chọn số tiền muốn nạp (tối thiểu 5,000đ):')
        .setTimestamp();
      await interaction.update({ embeds: [embed], ...createNapMenu() });
      return;
    }
    
    // Nút chọn số tiền nạp
    if (interaction.customId.startsWith('nap_')) {
      const amount = parseInt(interaction.customId.split('_')[1]);
      if (amount < 5000) {
        return interaction.reply({ content: '⚠️ Số tiền nạp tối thiểu là **5,000 VND**!', ephemeral: true });
      }
      
      await interaction.reply({ content: `🔄 Đang tạo mã thanh toán ${amount.toLocaleString()} VND...`, ephemeral: true });
      
      try {
        const orderCode = Number(Date.now());
        const description = `NAP${userId.slice(-8)}`;
        
        const paymentData = await createPaymentLink(orderCode, amount, description, userId, interaction.user.username);
        
        pendingPayments.set(orderCode, { userId, amount, timestamp: Date.now() });
        
        const embed = new EmbedBuilder()
          .setColor(0xFFA500)
          .setTitle('🧧 NẠP TIỀN')
          .setDescription(`💰 Số tiền: **${amount.toLocaleString()} VND**`)
          .addFields(
            { name: '🔗 LINK THANH TOÁN', value: `[Nhấn vào đây](${paymentData.checkoutUrl})`, inline: false },
            { name: '📝 Nội dung CK', value: `\`${description}\``, inline: true },
            { name: '⏰ Hết hạn', value: '15 phút', inline: true }
          )
          .setImage(paymentData.qrCode)
          .setFooter({ text: 'Sau khi chuyển khoản, bot sẽ tự động cộng tiền' })
          .setTimestamp();
        
        await interaction.editReply({ content: null, embeds: [embed] });
      } catch (error) {
        await interaction.editReply({ content: '❌ Lỗi tạo link thanh toán! Thử lại sau.', ephemeral: true });
      }
      return;
    }
    
    // Nút SỐ DƯ
    if (interaction.customId === 'sodu') {
      const balance = await db.getBalance(userId);
      const embed = new EmbedBuilder()
        .setColor(0x00FF00)
        .setTitle('💰 SỐ DƯ TÀI KHOẢN')
        .setDescription(`**${balance.toLocaleString()} VND**`)
        .setTimestamp();
      await interaction.reply({ embeds: [embed], ephemeral: true });
      return;
    }
    
    // Nút MUA HÀNG
    if (interaction.customId.startsWith('buy_')) {
      const productType = interaction.customId.replace('buy_', '');
      const price = PRICES[productType];
      const productName = PRODUCT_NAMES[productType];
      
      const balance = await db.getBalance(userId);
      if (balance < price) {
        return interaction.reply({ 
          content: `⚠️ Bạn không đủ tiền! Cần **${price.toLocaleString()} VND**, bạn có **${balance.toLocaleString()} VND**`,
          ephemeral: true 
        });
      }
      
      // Tìm clone có sẵn
      const clone = await db.getAvailableClone(productType);
      if (!clone) {
        return interaction.reply({ content: '❌ Sản phẩm này đã hết hàng! Vui lòng chờ admin nhập thêm.', ephemeral: true });
      }
      
      // Trừ tiền
      const result = await db.deductBalance(userId, price, clone.id, productType);
      if (result.success) {
        // Đánh dấu clone đã bán
        await db.markCloneSold(clone.id);
        
        // Lưu thông tin clone để gửi DM
        await db.savePendingClone(userId, clone.id, productType, clone.email, clone.password);
        
        // Gửi thông tin clone qua DM
        const user = await client.users.fetch(userId);
        const embed = new EmbedBuilder()
          .setColor(0x00FF00)
          .setTitle('✅ MUA HÀNG THÀNH CÔNG!')
          .setDescription(`Bạn đã mua **${productName}** với giá **${price.toLocaleString()} VND**`)
          .addFields(
            { name: '📧 Email', value: `||${clone.email}||`, inline: true },
            { name: '🔑 Mật khẩu', value: `||${clone.password}||`, inline: true },
            { name: '💰 Số dư còn lại', value: `${result.newBalance.toLocaleString()} VND`, inline: true }
          )
          .setFooter({ text: 'Thông tin đăng nhập chỉ hiện một lần, hãy lưu lại!' })
          .setTimestamp();
        
        await user.send({ embeds: [embed] }).catch(() => null);
        
        await interaction.reply({ 
          content: `✅ Mua **${productName}** thành công! Thông tin đăng nhập đã được gửi qua DM.`,
          ephemeral: true 
        });
      } else {
        await interaction.reply({ content: '❌ Giao dịch thất bại! Vui lòng thử lại.', ephemeral: true });
      }
      return;
    }
    
    // Nút HELP
    if (interaction.customId === 'help') {
      const embed = new EmbedBuilder()
        .setColor(0x0099FF)
        .setTitle('📖 HƯỚNG DẪN SỬ DỤNG')
        .setDescription('**Cách mua hàng:**\n1️⃣ Nhấn nút sản phẩm muốn mua\n2️⃣ Xác nhận giao dịch\n3️⃣ Nhận thông tin qua DM\n\n**Cách nạp tiền:**\n1️⃣ Nhấn nút NẠP TIỀN\n2️⃣ Chọn số tiền\n3️⃣ Quét QR hoặc bấm link\n4️⃣ Chuyển khoản\n5️⃣ Đợi 15-30 giây để cộng tiền\n\n**Lưu ý:**\n• Thông tin clone chỉ gửi 1 lần duy nhất\n• Bảo mật thông tin đăng nhập\n• Liên hệ admin nếu có vấn đề')
        .setTimestamp();
      await interaction.reply({ embeds: [embed], ephemeral: true });
      return;
    }
  }
});

// Xử lý lỗi
process.on('unhandledRejection', (error) => console.error('Unhandled rejection:', error));

client.login(process.env.DISCORD_TOKEN);
