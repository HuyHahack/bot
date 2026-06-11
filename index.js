const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const axios = require('axios');
const express = require('express');
const db = require('./database');
require('dotenv/config');

// ============ CHECK ENVIRONMENT ============
console.log('\n🔐 ========== CHECKING ENV ==========');
console.log('PAYOS_CLIENT_ID:', process.env.PAYOS_CLIENT_ID ? '✅' + process.env.PAYOS_CLIENT_ID.substring(0,10)+'...' : '❌ MISSING');
console.log('PAYOS_API_KEY:', process.env.PAYOS_API_KEY ? '✅' + process.env.PAYOS_API_KEY.substring(0,10)+'...' : '❌ MISSING');
const ck = process.env.PAYOS_CHECKSUM_KEY;
if(ck) {
    console.log('PAYOS_CHECKSUM_KEY length:', ck.length);
    if(ck.length !== 64) console.error('❌ ERROR: Checksum key length is NOT 64! It is:', ck.length);
    else console.log('✅ Checksum key length valid (64)');
} else {
    console.error('❌ PAYOS_CHECKSUM_KEY is MISSING!');
}
console.log('=====================================\n');

// ============ EXPRESS SERVER ============
const app = express();
app.use(express.json());
app.get('/', (req, res) => res.json({ status: 'online', bot: client?.user?.tag || 'starting' }));
app.get('/health', (req, res) => res.status(200).send('OK'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🌐 Web server chạy tại cổng ${PORT}`));

// ============ DISCORD BOT ============
const client = new Client({ 
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMessages] 
});

// Giá sản phẩm
const PRICES = { 'lv5': 2500, 'kc7d': 30000, 'kcvv': 40000 };
const PRODUCT_NAMES = { 'lv5': '🎮 Clone Level 5', 'kc7d': '⚡ Clone Rank KC (7 ngày)', 'kcvv': '💎 Clone Rank KC (Vĩnh viễn)' };
const ADMIN_IDS = ['1512658477841908015'];

const pendingPayments = new Map();
let mainMenuMessageId = null;
let mainMenuChannelId = null;

// ============ PAYOS API V2 (PRODUCTION) ============
const PAYOS_API_URL = 'https://api-merchant.payos.vn';

async function callPayOSAPI(endpoint, method, data = null, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      // ⭐⭐⭐ QUAN TRỌNG: THÊM .trim() VÀO CHECKSUM KEY ⭐⭐⭐
      const checksumKey = process.env.PAYOS_CHECKSUM_KEY ? process.env.PAYOS_CHECKSUM_KEY.trim() : '';
      
      const config = {
        method: method,
        url: `${PAYOS_API_URL}${endpoint}`,
        timeout: 20000,
        headers: {
          'x-client-id': process.env.PAYOS_CLIENT_ID?.trim(),
          'x-api-key': process.env.PAYOS_API_KEY?.trim(),
          'x-checksum-key': checksumKey,
          'Content-Type': 'application/json'
        }
      };
      
      if (data && method === 'POST') {
        config.data = data;
      }
      
      const response = await axios(config);
      console.log(`✅ PayOS API ${endpoint} response code:`, response.data?.code);
      return response.data;
      
    } catch (error) {
      console.log(`⚠️ Attempt ${i + 1} failed: ${error.message}`);
      if (error.response?.data) {
        console.log(`   Error detail:`, JSON.stringify(error.response.data));
      }
      if (i === retries - 1) throw error;
      await new Promise(r => setTimeout(r, 2000 * (i + 1)));
    }
  }
}

async function createPaymentLink(orderCode, amount, description, userId, username) {
  const paymentData = {
    orderCode: orderCode,
    amount: amount,
    description: description.substring(0, 25),
    returnUrl: `https://discord.com/users/${userId}`,
    cancelUrl: `https://discord.com/users/${userId}`,
    buyerName: username.substring(0, 50),
    buyerEmail: `${userId}@discord.user`,
    expiredAt: Math.floor(Date.now() / 1000) + 900
  };
  
  console.log(`📤 Creating payment link:`, JSON.stringify(paymentData, null, 2));
  
  const response = await callPayOSAPI('/v2/payment-requests', 'POST', paymentData);
  
  if (!response || response.code !== '00') {
    throw new Error(`${response?.desc || 'PayOS API error'} (code: ${response?.code})`);
  }
  
  const paymentLinkData = response.data;
  if (!paymentLinkData || !paymentLinkData.checkoutUrl) {
    console.error('Invalid response:', JSON.stringify(response, null, 2));
    throw new Error('Invalid response from PayOS');
  }
  
  return paymentLinkData;
}

async function checkPaymentStatus(orderCode) {
  try {
    const response = await callPayOSAPI(`/v2/payment-requests/${orderCode}`, 'GET');
    if (response && response.code === '00' && response.data) {
      return response.data;
    }
    return null;
  } catch (error) {
    return null;
  }
}

// ============ SLASH COMMANDS ============
const commands = [
  new SlashCommandBuilder().setName('start').setDescription('Hiển thị bảng điều khiển (Chỉ admin)'),
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
    .addStringOption(option => option.setName('email').setDescription('Email').setRequired(true))
    .addStringOption(option => option.setName('password').setDescription('Mật khẩu').setRequired(true)),
  new SlashCommandBuilder()
    .setName('addmoney')
    .setDescription('Cộng tiền cho user (Chỉ admin)')
    .addUserOption(option => option.setName('user').setDescription('Người dùng').setRequired(true))
    .addIntegerOption(option => option.setName('amount').setDescription('Số tiền (VNĐ)').setRequired(true))
];

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

client.once('ready', async () => {
  console.log(`✅ Bot đã đăng nhập: ${client.user.tag}`);
  console.log(`🔗 PayOS API V2: ${PAYOS_API_URL}`);
  
  try {
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands.map(cmd => cmd.toJSON()) });
    console.log('✅ Slash commands registered!');
  } catch (error) {
    console.error('❌ Error registering commands:', error);
  }
  
  setInterval(async () => {
    if (mainMenuChannelId && mainMenuMessageId) await updateMainMenu();
  }, 30000);
});

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
      .setDescription(`📋 **Bảng giá:**\n• 🎮 Clone Level 5: **2,500đ**\n• ⚡ Clone Rank KC (7 ngày): **30,000đ**\n• 💎 Clone Rank KC (Vĩnh viễn): **40,000đ**\n\n📦 **Tồn kho:**\n• Level 5: **${stats.lv5 || 0}** cái\n• KC 7 ngày: **${stats.kc7d || 0}** cái\n• KC Vĩnh viễn: **${stats.kcvv || 0}** cái\n\n⬇️ **Nhấn nút bên dưới để mua hàng!**`)
      .setFooter({ text: 'Mọi thắc mắc liên hệ Admin' })
      .setTimestamp();
    await message.edit({ embeds: [embed], components: createMainMenu().components });
  } catch (error) { console.error('Update menu error:', error); }
}

function createMainMenu() {
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('nap_menu').setLabel('💰 NẠP TIỀN').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('view_balance').setLabel('💎 XEM SỐ DƯ').setStyle(ButtonStyle.Primary)
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('buy_lv5').setLabel('🎮 Level 5 - 2,500đ').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('buy_kc7d').setLabel('⚡ KC 7 ngày - 30,000đ').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('buy_kcvv').setLabel('💎 KC Vĩnh viễn - 40,000đ').setStyle(ButtonStyle.Secondary)
  );
  const row3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('show_help').setLabel('❓ HƯỚNG DẪN').setStyle(ButtonStyle.Secondary)
  );
  return { components: [row1, row2, row3] };
}

function createNapMenu() {
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('nap_5000').setLabel('5,000đ').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('nap_10000').setLabel('10,000đ').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('nap_20000').setLabel('20,000đ').setStyle(ButtonStyle.Primary)
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('nap_50000').setLabel('50,000đ').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('nap_100000').setLabel('100,000đ').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('nap_custom').setLabel('✏️ NHẬP SỐ TIỀN').setStyle(ButtonStyle.Success)
  );
  const row3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('back_to_menu').setLabel('◀️ QUAY LẠI').setStyle(ButtonStyle.Danger)
  );
  return { components: [row1, row2, row3] };
}

setInterval(async () => {
  if (pendingPayments.size === 0) return;
  for (const [orderCode, payment] of pendingPayments) {
    if (Date.now() - payment.timestamp > 15 * 60 * 1000) {
      pendingPayments.delete(orderCode);
      continue;
    }
    const paymentData = await checkPaymentStatus(orderCode);
    if (paymentData && paymentData.status === 'PAID') {
      await db.addBalance(payment.userId, payment.amount, orderCode);
      console.log(`✅ Added ${payment.amount.toLocaleString()} VND to user ${payment.userId}`);
      const user = await client.users.fetch(payment.userId).catch(() => null);
      if (user) {
        const embed = new EmbedBuilder()
          .setColor(0x00FF00)
          .setTitle('✅ NẠP TIỀN THÀNH CÔNG!')
          .setDescription(`**${payment.amount.toLocaleString()} VND** đã được cộng.`)
          .addFields({ name: '💰 Số dư mới', value: `${(await db.getBalance(payment.userId)).toLocaleString()} VND` })
          .setTimestamp();
        await user.send({ embeds: [embed] }).catch(() => null);
      }
      pendingPayments.delete(orderCode);
      await updateMainMenu();
    }
  }
}, 15000);

// ============ XỬ LÝ TƯƠNG TÁC ============
client.on('interactionCreate', async interaction => {
  if (interaction.isCommand()) {
    if (interaction.commandName === 'start') {
      if (!ADMIN_IDS.includes(interaction.user.id)) return interaction.reply({ content: '❌ Bạn không có quyền!', ephemeral: true });
      const stats = await db.getAllProductsByType();
      const embed = new EmbedBuilder()
        .setColor(0x00FF00)
        .setTitle('🏪 CỬA HÀNG BÁN CLONE')
        .setDescription(`📋 **Bảng giá:**\n• 🎮 Clone Level 5: **2,500đ**\n• ⚡ Clone Rank KC (7 ngày): **30,000đ**\n• 💎 Clone Rank KC (Vĩnh viễn): **40,000đ**\n\n📦 **Tồn kho:**\n• Level 5: **${stats.lv5 || 0}** cái\n• KC 7 ngày: **${stats.kc7d || 0}** cái\n• KC Vĩnh viễn: **${stats.kcvv || 0}** cái\n\n⬇️ **Nhấn nút bên dưới để mua hàng!**`)
        .setFooter({ text: 'Mọi thắc mắc liên hệ Admin' })
        .setTimestamp();
      const message = await interaction.reply({ embeds: [embed], ...createMainMenu(), fetchReply: true });
      mainMenuMessageId = message.id;
      mainMenuChannelId = message.channel.id;
      return;
    }
    
    if (interaction.commandName === 'addclone') {
      if (!ADMIN_IDS.includes(interaction.user.id)) return interaction.reply({ content: '❌ Không có quyền!', ephemeral: true });
      const type = interaction.options.getString('type');
      const email = interaction.options.getString('email');
      const password = interaction.options.getString('password');
      await db.addClone(type, email, password);
      await interaction.reply({ content: `✅ Đã thêm ${PRODUCT_NAMES[type]}!`, ephemeral: true });
      await updateMainMenu();
      return;
    }
    
    if (interaction.commandName === 'addmoney') {
      if (!ADMIN_IDS.includes(interaction.user.id)) return interaction.reply({ content: '❌ Không có quyền!', ephemeral: true });
      const targetUser = interaction.options.getUser('user');
      const amount = interaction.options.getInteger('amount');
      await db.addBalance(targetUser.id, amount, null);
      await interaction.reply({ content: `✅ Đã cộng **${amount.toLocaleString()} VND** cho ${targetUser.username}!`, ephemeral: true });
      const user = await client.users.fetch(targetUser.id);
      const embed = new EmbedBuilder()
        .setColor(0x00FF00)
        .setTitle('💰 NẠP TIỀN THÀNH CÔNG')
        .setDescription(`Admin đã cộng **${amount.toLocaleString()} VND** vào tài khoản.`)
        .addFields({ name: '💎 Số dư mới', value: `${(await db.getBalance(targetUser.id)).toLocaleString()} VND` })
        .setTimestamp();
      await user.send({ embeds: [embed] }).catch(() => null);
      return;
    }
  }
  
  // MODAL - Nhập số tiền tùy chỉnh
  if (interaction.isModalSubmit()) {
    if (interaction.customId === 'custom_amount_modal') {
      const amountStr = interaction.fields.getTextInputValue('custom_amount');
      let amount = parseInt(amountStr.replace(/[^0-9]/g, ''));
      if (isNaN(amount) || amount < 5000) return interaction.reply({ content: '⚠️ Tối thiểu 5,000đ!', ephemeral: true });
      if (amount > 5000000) return interaction.reply({ content: '⚠️ Tối đa 5,000,000đ!', ephemeral: true });
      
      await interaction.reply({ content: `🔄 Đang tạo mã thanh toán ${amount.toLocaleString()} VND...`, ephemeral: true });
      try {
        const orderCode = Number(Date.now());
        const description = `NAP${interaction.user.id.slice(-8)}`;
        const paymentData = await createPaymentLink(orderCode, amount, description, interaction.user.id, interaction.user.username);
        pendingPayments.set(orderCode, { userId: interaction.user.id, amount, timestamp: Date.now() });
        const embed = new EmbedBuilder()
          .setColor(0xFFA500)
          .setTitle('🧧 NẠP TIỀN')
          .setDescription(`💰 Số tiền: **${amount.toLocaleString()} VND**`)
          .addFields(
            { name: '🔗 LINK THANH TOÁN', value: `[Nhấn vào đây](${paymentData.checkoutUrl})`, inline: false },
            { name: '📝 Nội dung CK', value: `\`${description}\``, inline: true },
            { name: '⏰ Hết hạn sau', value: '15 phút', inline: true }
          )
          .setImage(paymentData.qrCode)
          .setFooter({ text: 'Sau khi chuyển khoản, bot sẽ tự cộng tiền sau 15-30 giây' });
        await interaction.editReply({ content: null, embeds: [embed] });
      } catch (error) {
        console.error('Nap error:', error);
        await interaction.editReply({ content: `❌ Lỗi: ${error.message}\n\n💡 Liên hệ Admin để nạp thủ công!`, ephemeral: true });
      }
      return;
    }
  }
  
  // BUTTONS
  if (interaction.isButton()) {
    const userId = interaction.user.id;
    
    if (interaction.customId === 'nap_menu') {
      const embed = new EmbedBuilder().setColor(0xFFA500).setTitle('💰 NẠP TIỀN ONLINE').setDescription('Chọn số tiền (tối thiểu 5,000đ):');
      await interaction.update({ embeds: [embed], components: createNapMenu().components, ephemeral: true });
      return;
    }
    
    if (interaction.customId === 'nap_custom') {
      const modal = new ModalBuilder().setCustomId('custom_amount_modal').setTitle('💰 NHẬP SỐ TIỀN');
      const amountInput = new TextInputBuilder().setCustomId('custom_amount').setLabel('Số tiền (VNĐ)').setStyle(TextInputStyle.Short).setPlaceholder('Ví dụ: 50000').setRequired(true);
      modal.addComponents(new ActionRowBuilder().addComponents(amountInput));
      await interaction.showModal(modal);
      return;
    }
    
    if (interaction.customId === 'back_to_menu') {
      const stats = await db.getAllProductsByType();
      const embed = new EmbedBuilder().setColor(0x00FF00).setTitle('🏪 CỬA HÀNG').setDescription(`📦 **Tồn kho:** Level 5: ${stats.lv5 || 0}, KC7d: ${stats.kc7d || 0}, KCvv: ${stats.kcvv || 0}`);
      await interaction.update({ embeds: [embed], components: createMainMenu().components, ephemeral: true });
      return;
    }
    
    if (interaction.customId === 'view_balance') {
      const balance = await db.getBalance(userId);
      await interaction.reply({ embeds: [new EmbedBuilder().setColor(0x00FF00).setTitle('💰 SỐ DƯ').setDescription(`**${balance.toLocaleString()} VND**`)], ephemeral: true });
      return;
    }
    
    if (interaction.customId === 'show_help') {
      const embed = new EmbedBuilder().setColor(0x0099FF).setTitle('📖 HƯỚNG DẪN').setDescription('**Cách mua hàng:**\n1️⃣ Nhấn nút sản phẩm\n2️⃣ Xác nhận\n3️⃣ Nhận thông tin qua DM\n\n**Cách nạp tiền:**\n1️⃣ Nhấn NẠP TIỀN\n2️⃣ Chọn số tiền\n3️⃣ Quét QR chuyển khoản');
      await interaction.reply({ embeds: [embed], ephemeral: true });
      return;
    }
    
    // Nạp tiền có sẵn
    if (interaction.customId.startsWith('nap_') && !interaction.customId.includes('custom') && !interaction.customId.includes('menu') && !interaction.customId.includes('back')) {
      const amount = parseInt(interaction.customId.split('_')[1]);
      if (amount < 5000) return interaction.reply({ content: '⚠️ Tối thiểu 5,000đ!', ephemeral: true });
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
            { name: '📝 Nội dung CK', value: `\`${description}\``, inline: true }
          )
          .setImage(paymentData.qrCode);
        await interaction.editReply({ content: null, embeds: [embed] });
      } catch (error) {
        await interaction.editReply({ content: `❌ Lỗi: ${error.message}`, ephemeral: true });
      }
      return;
    }
    
    // MUA HÀNG
    const buyActions = { buy_lv5: 'lv5', buy_kc7d: 'kc7d', buy_kcvv: 'kcvv' };
    if (buyActions[interaction.customId]) {
      const productType = buyActions[interaction.customId];
      const price = PRICES[productType];
      const balance = await db.getBalance(userId);
      if (balance < price) return interaction.reply({ content: `⚠️ Không đủ tiền! Cần ${price.toLocaleString()}đ`, ephemeral: true });
      const clone = await db.getAvailableClone(productType);
      if (!clone) return interaction.reply({ content: '❌ Hết hàng!', ephemeral: true });
      const result = await db.deductBalance(userId, price, clone.id, productType);
      if (result.success) {
        await db.markCloneSold(clone.id);
        const user = await client.users.fetch(userId);
        await user.send(`✅ Mua ${PRODUCT_NAMES[productType]} thành công!\n📧 Email: ||${clone.email}||\n🔑 Pass: ||${clone.password}||`);
        await interaction.reply({ content: `✅ Mua thành công! Đã gửi DM.`, ephemeral: true });
        await updateMainMenu();
      } else {
        await interaction.reply({ content: '❌ Giao dịch thất bại!', ephemeral: true });
      }
      return;
    }
  }
});

process.on('unhandledRejection', (error) => console.error('Unhandled rejection:', error));
client.login(process.env.DISCORD_TOKEN);
