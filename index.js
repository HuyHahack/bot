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
const ADMIN_IDS = ['1512658477841908015'];

// Lưu giao dịch chờ
const pendingPayments = new Map();

// Lưu message ID của bảng điều khiển để cập nhật sau
let mainMenuMessageId = null;
let mainMenuChannelId = null;

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
  
  // Tự động cập nhật bảng điều khiển mỗi 30 giây
  setInterval(async () => {
    if (mainMenuChannelId && mainMenuMessageId) {
      await updateMainMenu();
    }
  }, 30000);
});

// Hàm cập nhật bảng điều khiển (tồn kho)
async function updateMainMenu() {
  if (!mainMenuChannelId || !mainMenuMessageId) return;
  
  const channel = client.channels.cache.get(mainMenuChannelId);
  if (!channel) return;
  
  try {
    const message = await channel.messages.fetch(mainMenuMessageId);
    const stats = await db.getAllProductsByType();
    
    const embed = new EmbedBuilder()
      .setColor(0x00FF00)
      .setTitle('🏪 CỬA HÀNG BÁN CLONE')
      .setDescription('Chào mừng bạn đến với cửa hàng!\n\n📋 **Bảng giá:**\n• 🎮 Clone Level 5: **2,500đ**\n• ⚡ Clone Rank KC (7 ngày): **30,000đ**\n• 💎 Clone Rank KC (Vĩnh viễn): **40,000đ**\n\n📦 **Tồn kho hiện tại:**\n• Level 5: **' + (stats.lv5 || 0) + '** cái\n• KC 7 ngày: **' + (stats.kc7d || 0) + '** cái\n• KC Vĩnh viễn: **' + (stats.kcvv || 0) + '** cái\n\n⬇️ **Nhấn nút bên dưới để mua hàng!**')
      .setFooter({ text: 'Mọi thắc mắc liên hệ Admin' })
      .setTimestamp();
    
    await message.edit({ embeds: [embed], components: createMainMenu().components });
  } catch (error) {
    console.error('Update main menu error:', error);
  }
}

// Hàm tạo menu chính (DÙNG EPHEMERAL CHO CÁC TƯƠNG TÁC RIÊNG TƯ)
function createMainMenu() {
  const row1 = new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder().setCustomId('view_balance').setLabel('💰 XEM SỐ DƯ').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('buy_lv5').setLabel('🎮 Level 5 - 2,500đ').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('buy_kc7d').setLabel('⚡ KC 7 ngày - 30,000đ').setStyle(ButtonStyle.Success)
    );
  
  const row2 = new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder().setCustomId('buy_kcvv').setLabel('💎 KC Vĩnh viễn - 40,000đ').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('show_help').setLabel('❓ HƯỚNG DẪN').setStyle(ButtonStyle.Secondary)
    );
  
  return { components: [row1, row2] };
}

// Hàm tạo menu nạp tiền (RIÊNG TƯ)
function createNapMenu() {
  const row = new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder().setCustomId('nap_5000').setLabel('5,000đ').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('nap_10000').setLabel('10,000đ').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('nap_20000').setLabel('20,000đ').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('nap_50000').setLabel('50,000đ').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('nap_100000').setLabel('100,000đ').setStyle(ButtonStyle.Primary)
    );
  
  const row2 = new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder().setCustomId('back_to_menu').setLabel('◀️ QUAY LẠI').setStyle(ButtonStyle.Danger)
    );
  
  return { components: [row, row2] };
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

// Kiểm tra thanh toán
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
    console.error(`Check payment error:`, error.message);
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
      
      // Cập nhật bảng điều khiển (tồn kho có thể thay đổi)
      await updateMainMenu();
    }
  }
}, 15000);

// ============ XỬ LÝ TƯƠNG TÁC ============
client.on('interactionCreate', async interaction => {
  // XỬ LÝ SLASH COMMANDS
  if (interaction.isCommand()) {
    // /start - Chỉ admin, tạo bảng công khai
    if (interaction.commandName === 'start') {
      if (!ADMIN_IDS.includes(interaction.user.id)) {
        return interaction.reply({ content: '❌ Bạn không có quyền sử dụng lệnh này!', ephemeral: true });
      }
      
      const stats = await db.getAllProductsByType();
      const embed = new EmbedBuilder()
        .setColor(0x00FF00)
        .setTitle('🏪 CỬA HÀNG BÁN CLONE')
        .setDescription('Chào mừng bạn đến với cửa hàng!\n\n📋 **Bảng giá:**\n• 🎮 Clone Level 5: **2,500đ**\n• ⚡ Clone Rank KC (7 ngày): **30,000đ**\n• 💎 Clone Rank KC (Vĩnh viễn): **40,000đ**\n\n📦 **Tồn kho hiện tại:**\n• Level 5: **' + (stats.lv5 || 0) + '** cái\n• KC 7 ngày: **' + (stats.kc7d || 0) + '** cái\n• KC Vĩnh viễn: **' + (stats.kcvv || 0) + '** cái\n\n⬇️ **Nhấn nút bên dưới để mua hàng!**')
        .setFooter({ text: 'Mọi thắc mắc liên hệ Admin' })
        .setTimestamp();
      
      const message = await interaction.reply({ embeds: [embed], ...createMainMenu(), fetchReply: true });
      
      // Lưu lại để tự động cập nhật tồn kho
      mainMenuMessageId = message.id;
      mainMenuChannelId = message.channel.id;
      return;
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
      
      // Cập nhật bảng điều khiển
      await updateMainMenu();
      return;
    }
  }
  
  // XỬ LÝ NÚT BẤM (TẤT CẢ ĐỀU EPHEMERAL - CHỈ USER BẤM THẤY)
  if (interaction.isButton()) {
    const userId = interaction.user.id;
    
    // Nút XEM SỐ DƯ (ephemeral)
    if (interaction.customId === 'view_balance') {
      const balance = await db.getBalance(userId);
      const embed = new EmbedBuilder()
        .setColor(0x00FF00)
        .setTitle('💰 SỐ DƯ TÀI KHOẢN')
        .setDescription(`**${balance.toLocaleString()} VND**`)
        .setTimestamp();
      
      await interaction.reply({ embeds: [embed], ephemeral: true });
      return;
    }
    
    // Nút quay lại (ephemeral)
    if (interaction.customId === 'back_to_menu') {
      const embed = new EmbedBuilder()
        .setColor(0x00FF00)
        .setTitle('🏪 CỬA HÀNG BÁN CLONE')
        .setDescription('Chọn sản phẩm bạn muốn mua:')
        .setTimestamp();
      
      await interaction.update({ embeds: [embed], components: createMainMenu().components, ephemeral: true });
      return;
    }
    
    // Nút HƯỚNG DẪN (ephemeral)
    if (interaction.customId === 'show_help') {
      const embed = new EmbedBuilder()
        .setColor(0x0099FF)
        .setTitle('📖 HƯỚNG DẪN SỬ DỤNG')
        .setDescription('**Cách mua hàng:**\n1️⃣ Nhấn nút sản phẩm muốn mua\n2️⃣ Xác nhận giao dịch\n3️⃣ Nhận thông tin qua DM\n\n**Cách nạp tiền (chưa có tiền):**\n→ Liên hệ Admin để được hỗ trợ nạp\n\n**Lưu ý:**\n• Thông tin clone chỉ gửi 1 lần duy nhất\n• Bảo mật thông tin đăng nhập\n• Liên hệ admin nếu có vấn đề')
        .setTimestamp();
      
      await interaction.reply({ embeds: [embed], ephemeral: true });
      return;
    }
    
    // Nút NẠP TIỀN (chưa có chức năng vì min 5k, để dành cho admin)
    if (interaction.customId.startsWith('nap_')) {
      // Hiện tại chưa mở nạp online, chỉ admin nạp thủ công
      await interaction.reply({ 
        content: '⚠️ Hiện tại tính năng nạp online đang tạm khóa. Vui lòng liên hệ Admin để được hỗ trợ nạp tiền!\n\n💬 Liên hệ: @admin', 
        ephemeral: true 
      });
      return;
    }
    
    // Nút MUA LEVEL 5
    if (interaction.customId === 'buy_lv5') {
      const productType = 'lv5';
      const price = PRICES[productType];
      const productName = PRODUCT_NAMES[productType];
      
      const balance = await db.getBalance(userId);
      if (balance < price) {
        return interaction.reply({ 
          content: `⚠️ Bạn không đủ tiền! Cần **${price.toLocaleString()} VND**, bạn có **${balance.toLocaleString()} VND**\n\n💬 Liên hệ Admin để nạp thêm tiền!`, 
          ephemeral: true 
        });
      }
      
      const clone = await db.getAvailableClone(productType);
      if (!clone) {
        return interaction.reply({ content: '❌ Sản phẩm này đã hết hàng! Vui lòng chờ admin nhập thêm.', ephemeral: true });
      }
      
      // Trừ tiền
      const result = await db.deductBalance(userId, price, clone.id, productType);
      if (result.success) {
        await db.markCloneSold(clone.id);
        await db.savePendingClone(userId, clone.id, productType, clone.email, clone.password);
        
        // Gửi DM
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
        
        // Cập nhật tồn kho
        await updateMainMenu();
      } else {
        await interaction.reply({ content: '❌ Giao dịch thất bại! Vui lòng thử lại.', ephemeral: true });
      }
      return;
    }
    
    // Nút MUA KC 7 NGÀY
    if (interaction.customId === 'buy_kc7d') {
      const productType = 'kc7d';
      const price = PRICES[productType];
      const productName = PRODUCT_NAMES[productType];
      
      const balance = await db.getBalance(userId);
      if (balance < price) {
        return interaction.reply({ 
          content: `⚠️ Bạn không đủ tiền! Cần **${price.toLocaleString()} VND**, bạn có **${balance.toLocaleString()} VND**\n\n💬 Liên hệ Admin để nạp thêm tiền!`, 
          ephemeral: true 
        });
      }
      
      const clone = await db.getAvailableClone(productType);
      if (!clone) {
        return interaction.reply({ content: '❌ Sản phẩm này đã hết hàng! Vui lòng chờ admin nhập thêm.', ephemeral: true });
      }
      
      const result = await db.deductBalance(userId, price, clone.id, productType);
      if (result.success) {
        await db.markCloneSold(clone.id);
        await db.savePendingClone(userId, clone.id, productType, clone.email, clone.password);
        
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
        
        await updateMainMenu();
      } else {
        await interaction.reply({ content: '❌ Giao dịch thất bại! Vui lòng thử lại.', ephemeral: true });
      }
      return;
    }
    
    // Nút MUA KC VĨNH VIỄN
    if (interaction.customId === 'buy_kcvv') {
      const productType = 'kcvv';
      const price = PRICES[productType];
      const productName = PRODUCT_NAMES[productType];
      
      const balance = await db.getBalance(userId);
      if (balance < price) {
        return interaction.reply({ 
          content: `⚠️ Bạn không đủ tiền! Cần **${price.toLocaleString()} VND**, bạn có **${balance.toLocaleString()} VND**\n\n💬 Liên hệ Admin để nạp thêm tiền!`, 
          ephemeral: true 
        });
      }
      
      const clone = await db.getAvailableClone(productType);
      if (!clone) {
        return interaction.reply({ content: '❌ Sản phẩm này đã hết hàng! Vui lòng chờ admin nhập thêm.', ephemeral: true });
      }
      
      const result = await db.deductBalance(userId, price, clone.id, productType);
      if (result.success) {
        await db.markCloneSold(clone.id);
        await db.savePendingClone(userId, clone.id, productType, clone.email, clone.password);
        
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
        
        await updateMainMenu();
      } else {
        await interaction.reply({ content: '❌ Giao dịch thất bại! Vui lòng thử lại.', ephemeral: true });
      }
      return;
    }
  }
});

// Xử lý lỗi
process.on('unhandledRejection', (error) => console.error('Unhandled rejection:', error));

client.login(process.env.DISCORD_TOKEN);
