const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, StringSelectMenuBuilder, StringSelectMenuOptionBuilder } = require('discord.js');
const axios = require('axios');
const express = require('express');
const crypto = require('crypto');
const db = require('./database');
require('dotenv/config');

// ============ CHECK ENVIRONMENT ============
console.log('\n🔐 ========== CHECKING ENV ==========');
console.log('PAYOS_CLIENT_ID:', process.env.PAYOS_CLIENT_ID ? '✅' : '❌');
console.log('PAYOS_API_KEY:', process.env.PAYOS_API_KEY ? '✅' : '❌');
console.log('PAYOS_CHECKSUM_KEY length:', process.env.PAYOS_CHECKSUM_KEY?.length || 0);
console.log('=====================================\n');

// ============ EXPRESS SERVER ============
const app = express();
app.use(express.json());
app.get('/', (req, res) => res.json({ status: 'online' }));
app.get('/health', (req, res) => res.status(200).send('OK'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🌐 Web server chạy tại cổng ${PORT}`));

// ============ DISCORD BOT ============
const client = new Client({ 
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMessages] 
});

// Giá sản phẩm (Thêm kclogx giá 40,000đ)
const PRICES = { 'lv5': 2500, 'kc7d': 30000, 'kcvv': 40000, 'kclogx': 40000 };
const PRODUCT_NAMES = { 
  'lv5': '🎮 Clone Level 5', 
  'kc7d': '⚡ Clone KC Mail 7 ngày', 
  'kcvv': '💎 Clone KC Mail Vĩnh viễn',
  'kclogx': '🐦 Clone KC Log X'
};
const ADMIN_IDS = ['1507070505319006380']; // Thay ID admin của bạn

const pendingPayments = new Map();
let mainMenuMessageId = null;
let mainMenuChannelId = null;

// ============ PAYOS API V2 ============
const PAYOS_API_URL = 'https://api-merchant.payos.vn';

function createSignature(checksumKey, orderCode, amount, description, returnUrl, cancelUrl) {
  const data = `amount=${amount}&cancelUrl=${cancelUrl}&description=${description}&orderCode=${orderCode}&returnUrl=${returnUrl}`;
  return crypto.createHmac('sha256', checksumKey).update(data).digest('hex');
}

async function createPaymentLink(orderCode, amount, description, userId, username) {
  const returnUrl = `https://discord.com/users/${userId}`;
  const cancelUrl = `https://discord.com/users/${userId}`;
  
  const signature = createSignature(
    process.env.PAYOS_CHECKSUM_KEY.trim(),
    orderCode, amount, description, returnUrl, cancelUrl
  );
  
  const body = { orderCode, amount, description, returnUrl, cancelUrl, signature };
  
  const response = await axios.post(`${PAYOS_API_URL}/v2/payment-requests`, body, {
    headers: {
      'x-client-id': process.env.PAYOS_CLIENT_ID.trim(),
      'x-api-key': process.env.PAYOS_API_KEY.trim(),
      'Content-Type': 'application/json'
    },
    timeout: 15000
  });
  
  if (response.data.code !== '00') {
    throw new Error(`${response.data.desc} (code: ${response.data.code})`);
  }
  
  return response.data.data;
}

async function checkPaymentStatus(orderCode) {
  try {
    const response = await axios.get(`${PAYOS_API_URL}/v2/payment-requests/${orderCode}`, {
      headers: {
        'x-client-id': process.env.PAYOS_CLIENT_ID.trim(),
        'x-api-key': process.env.PAYOS_API_KEY.trim()
      },
      timeout: 10000
    });
    return response.data?.data || null;
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
          { name: 'Rank KC Vĩnh viễn (40,000đ)', value: 'kcvv' },
          { name: 'Rank KC Log X (40,000đ)', value: 'kclogx' }
        ))
    .addStringOption(option => option.setName('email').setDescription('Email/Tài khoản').setRequired(true))
    .addStringOption(option => option.setName('password').setDescription('Mật khẩu').setRequired(true)),
  new SlashCommandBuilder()
    .setName('removeclone')
    .setDescription('Xóa clone khỏi kho (Chỉ admin)')
    .addIntegerOption(option => option.setName('id').setDescription('ID của clone cần xóa')),
  new SlashCommandBuilder()
    .setName('addmoney')
    .setDescription('Cộng tiền cho user (Chỉ admin)')
    .addUserOption(option => option.setName('user').setDescription('Người dùng').setRequired(true))
    .addIntegerOption(option => option.setName('amount').setDescription('Số tiền (VNĐ)').setRequired(true))
];

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

client.once('ready', async () => {
  console.log(`✅ Bot đã đăng nhập: ${client.user.tag}`);
  
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
      .setColor(0xFF0000) // Viền đỏ giống ảnh minh họa
      .setAuthor({ name: '🤖 Mua Acc Clone Free Fire Tự Động' })
      .setTitle('Chào mừng đến với Acc Clone Faifai')
      .setDescription(
        `💰 **Nạp tiền** để mua hàng\n` +
        `📊 **Số dư** để kiểm tra số dư hiện tại\n\n` +
        `🟦 **Acc Clone LV5:** \`${(PRICES.lv5).toLocaleString()} VND\` /acc | 📦 Kho: \`${stats.lv5 || 0}\`\n` +
        `🟩 **Acc Clone KC Mail 7 ngày:** \`${(PRICES.kc7d).toLocaleString()} VND\` /acc | 📦 Kho: \`${stats.kc7d || 0}\`\n` +
        `🟪 **Acc Clone KC Mail Vĩnh viễn:** \`${(PRICES.kcvv).toLocaleString()} VND\` /acc | 📦 Kho: \`${stats.kcvv || 0}\`\n` +
        `🐦 **Acc Clone KC Log X:** \`${(PRICES.kclogx).toLocaleString()} VND\` /acc | 📦 Kho: \`${stats.kclogx || 0}\`\n\n` +
        `⚠️ **Lưu ý quan trọng:**\n` +
        `Yêu cầu quay video khi mua và login luôn\n` +
        `ngay sau khi vừa mua để làm bằng chứng.\n` +
        `Không có video sẽ không giải quyết khiếu nại!\n\n` +
        `**Hỗ trợ :** <@1507070505319006380>`
      )
      .setThumbnail('https://cdn.discordapp.com/attachments/630397588092354561/922156242565214278/image0-3-3.gif')
      .setFooter({ text: 'Hệ thống bán Acc tự động' });
    
    const rowButton = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('nap_menu').setLabel('💰 Nạp tiền').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('view_balance').setLabel('📊 Số dư').setStyle(ButtonStyle.Secondary)
    );

    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId('product_select')
      .setPlaceholder('🛒 | Chọn sản phẩm để mua')
      .addOptions([
        new StringSelectMenuOptionBuilder()
          .setLabel('🎮 Clone Level 5')
          .setDescription(`Giá: ${(PRICES.lv5).toLocaleString()}đ`)
          .setValue('lv5')
          .setEmoji('🎮'),
        new StringSelectMenuOptionBuilder()
          .setLabel('⚡ Clone KC Mail 7 ngày')
          .setDescription(`Giá: ${(PRICES.kc7d).toLocaleString()}đ`)
          .setValue('kc7d')
          .setEmoji('⚡'),
        new StringSelectMenuOptionBuilder()
          .setLabel('💎 Clone KC Mail Vĩnh viễn')
          .setDescription(`Giá: ${(PRICES.kcvv).toLocaleString()}đ`)
          .setValue('kcvv')
          .setEmoji('💎'),
        new StringSelectMenuOptionBuilder()
          .setLabel('🐦 Clone KC Log X')
          .setDescription(`Giá: ${(PRICES.kclogx).toLocaleString()}đ`)
          .setValue('kclogx')
          .setEmoji('🐦')
      ]);
    
    const rowSelect = new ActionRowBuilder().addComponents(selectMenu);
    
    await message.edit({ embeds: [embed], components: [rowButton, rowSelect] });
  } catch (error) { console.error('Update menu error:', error); }
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
    new ButtonBuilder().setCustomId('back_to_main_menu').setLabel('◀️ QUAY LẠI').setStyle(ButtonStyle.Danger)
  );
  return { components: [row1, row2, row3] };
}

// Hiển thị danh sách clone để xóa
async function showRemoveCloneMenu(interaction) {
  const clones = await db.getAllClones();
  const availableClones = clones.filter(c => c.status === 'available');
  
  if (availableClones.length === 0) {
    return interaction.reply({ content: '📦 Không có clone nào trong kho!', ephemeral: true });
  }
  
  const grouped = { lv5: [], kc7d: [], kcvv: [], kclogx: [] };
  availableClones.forEach(clone => { if(grouped[clone.type]) grouped[clone.type].push(clone); });
  
  let description = '**📋 DANH SÁCH CLONE TRONG KHO:**\n\n';
  for (const [type, clones] of Object.entries(grouped)) {
    if (clones.length === 0) continue;
    description += `**${PRODUCT_NAMES[type]}** (${clones.length} cái):\n`;
    clones.forEach(clone => { description += `└ ID: \`${clone.id}\` - ${clone.email}\n`; });
    description += '\n';
  }
  description += '\n💡 **Cách xóa:** Gõ `/removeclone id:<ID>` để xóa clone theo ID';
  
  const embed = new EmbedBuilder().setColor(0xFF6600).setTitle('🗑️ QUẢN LÝ CLONE').setDescription(description).setTimestamp();
  await interaction.reply({ embeds: [embed], ephemeral: true });
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

// ============ XỬ LÝ MUA HÀNG TỪ SELECT MENU ============
async function handlePurchase(interaction, productType) {
  const userId = interaction.user.id;
  const price = PRICES[productType];
  const productName = PRODUCT_NAMES[productType];
  
  const balance = await db.getBalance(userId);
  if (balance < price) {
    await interaction.editReply({ 
      content: `⚠️ Không đủ tiền! Cần ${price.toLocaleString()}đ, bạn có ${balance.toLocaleString()}đ\n💰 Hãy nạp tiền bằng nút NẠP TIỀN bên trên!`
    });
    setTimeout(() => {
      interaction.deleteReply().catch(() => {});
    }, 5 * 60 * 1000);
    return;
  }
  
  const clone = await db.getAvailableClone(productType);
  if (!clone) {
    await interaction.editReply({ content: '❌ Sản phẩm này đã hết hàng! Vui lòng chờ admin nhập thêm.\n📞 Liên hệ Admin để được hỗ trợ!' });
    setTimeout(() => {
      interaction.deleteReply().catch(() => {});
    }, 5 * 60 * 1000);
    return;
  }
  
  const result = await db.deductBalance(userId, price, clone.id, productType);
  if (result.success) {
    await db.markCloneSold(clone.id);
    const user = await client.users.fetch(userId);
    const embed = new EmbedBuilder()
      .setColor(0x00FF00)
      .setTitle('✅ MUA HÀNG THÀNH CÔNG!')
      .setDescription(`Bạn đã mua **${productName}** với giá **${price.toLocaleString()} VND**`)
      .addFields(
        { name: '📧 Email/Tài khoản', value: `||${clone.email}||`, inline: true },
        { name: '🔑 Mật khẩu', value: `||${clone.password}||`, inline: true },
        { name: '💰 Số dư còn lại', value: `${result.newBalance.toLocaleString()} VND`, inline: true }
      )
      .setFooter({ text: 'Lưu lại thông tin này!' })
      .setTimestamp();
    
    await user.send({ embeds: [embed] }).catch(() => null);
    await interaction.editReply({ content: `✅ Mua **${productName}** thành công! Đã gửi thông tin qua DM.` });
    await updateMainMenu();
    setTimeout(() => {
      interaction.deleteReply().catch(() => {});
    }, 5 * 60 * 1000);
  } else {
    await interaction.editReply({ content: '❌ Giao dịch thất bại! Vui lòng thử lại.' });
    setTimeout(() => {
      interaction.deleteReply().catch(() => {});
    }, 5 * 60 * 1000);
  }
}

// ============ XỬ LÝ TƯƠNG TÁC ============
client.on('interactionCreate', async interaction => {
  // SLASH COMMANDS
  if (interaction.isCommand()) {
    if (interaction.commandName === 'start') {
      if (!ADMIN_IDS.includes(interaction.user.id)) {
        return interaction.reply({ content: '❌ Bạn không có quyền!', ephemeral: true });
      }
      const stats = await db.getAllProductsByType();
      const embed = new EmbedBuilder()
        .setColor(0xFF0000) // Màu đỏ
        .setAuthor({ name: '🤖 Mua Acc Clone Free Fire Tự Động' })
        .setTitle('Chào mừng đến với Acc Clone Faifai')
        .setDescription(
          `💰 **Nạp tiền** để mua hàng\n` +
          `📊 **Số dư** để kiểm tra số dư hiện tại\n\n` +
          `🟦 **Acc Clone LV5:** \`${(PRICES.lv5).toLocaleString()} VND\` /acc | 📦 Kho: \`${stats.lv5 || 0}\`\n` +
          `🟩 **Acc Clone KC Mail 7 ngày:** \`${(PRICES.kc7d).toLocaleString()} VND\` /acc | 📦 Kho: \`${stats.kc7d || 0}\`\n` +
          `🟪 **Acc Clone KC Mail Vĩnh viễn:** \`${(PRICES.kcvv).toLocaleString()} VND\` /acc | 📦 Kho: \`${stats.kcvv || 0}\`\n` +
          `🐦 **Acc Clone KC Log X:** \`${(PRICES.kclogx).toLocaleString()} VND\` /acc | 📦 Kho: \`${stats.kclogx || 0}\`\n\n` +
          `⚠️ **Lưu ý quan trọng:**\n` +
          `Yêu cầu quay video khi mua và login luôn\n` +
          `ngay sau khi vừa mua để làm bằng chứng.\n` +
          `Không có video sẽ không giải quyết khiếu nại!\n\n` +
          `**Hỗ trợ :** <@1507070505319006380>`
        )
        .setThumbnail('https://cdn.discordapp.com/attachments/630397588092354561/922156242565214278/image0-3-3.gif')
        .setFooter({ text: 'Hệ thống bán Acc tự động' });
      
      const selectMenu = new StringSelectMenuBuilder()
        .setCustomId('product_select')
        .setPlaceholder('🛒 | Chọn sản phẩm để mua')
        .addOptions([
          new StringSelectMenuOptionBuilder()
            .setLabel('🎮 Clone Level 5')
            .setDescription(`Giá: ${(PRICES.lv5).toLocaleString()}đ`)
            .setValue('lv5')
            .setEmoji('🎮'),
          new StringSelectMenuOptionBuilder()
            .setLabel('⚡ Clone KC Mail 7 ngày')
            .setDescription(`Giá: ${(PRICES.kc7d).toLocaleString()}đ`)
            .setValue('kc7d')
            .setEmoji('⚡'),
          new StringSelectMenuOptionBuilder()
            .setLabel('💎 Clone KC Mail Vĩnh viễn')
            .setDescription(`Giá: ${(PRICES.kcvv).toLocaleString()}đ`)
            .setValue('kcvv')
            .setEmoji('💎'),
          new StringSelectMenuOptionBuilder()
            .setLabel('🐦 Clone KC Log X')
            .setDescription(`Giá: ${(PRICES.kclogx).toLocaleString()}đ`)
            .setValue('kclogx')
            .setEmoji('🐦')
        ]);
      
      const rowButton = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('nap_menu').setLabel('💰 Nạp tiền').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('view_balance').setLabel('📊 Số dư').setStyle(ButtonStyle.Secondary)
      );

      const rowSelect = new ActionRowBuilder().addComponents(selectMenu);
      
      const message = await interaction.reply({ embeds: [embed], components: [rowButton, rowSelect], fetchReply: true });
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
      await interaction.reply({ content: `✅ Đã thêm ${PRODUCT_NAMES[type]}!\n📧 ${email}\n🔑 ${password}`, ephemeral: true });
      await updateMainMenu();
      setTimeout(() => {
        interaction.deleteReply().catch(() => {});
      }, 5 * 60 * 1000);
      return;
    }
    
    if (interaction.commandName === 'removeclone') {
      if (!ADMIN_IDS.includes(interaction.user.id)) return interaction.reply({ content: '❌ Không có quyền!', ephemeral: true });
      const cloneId = interaction.options.getInteger('id');
      if (cloneId) {
        const removed = await db.removeCloneById(cloneId);
        if (removed) {
          await interaction.reply({ content: `✅ Đã xóa clone ID \`${cloneId}\` (${removed.email}) khỏi kho!`, ephemeral: true });
          await updateMainMenu();
        } else {
          await interaction.reply({ content: `❌ Không tìm thấy clone với ID \`${cloneId}\`!`, ephemeral: true });
        }
        setTimeout(() => {
          interaction.deleteReply().catch(() => {});
        }, 5 * 60 * 1000);
      } else {
        await showRemoveCloneMenu(interaction);
      }
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
      setTimeout(() => {
        interaction.deleteReply().catch(() => {});
      }, 5 * 60 * 1000);
      return;
    }
  }
  
  // SELECT MENU - Xử lý chọn sản phẩm (Riêng tư - Ephemeral)
  if (interaction.isStringSelectMenu()) {
    if (interaction.customId === 'product_select') {
      const selectedValue = interaction.values[0];
      await interaction.deferReply({ ephemeral: true });
      await handlePurchase(interaction, selectedValue);
      return;
    }
  }
  
  // MODAL - Nhập số tiền tùy chỉnh (Riêng tư - Ephemeral, tự xóa sau 5 phút)
  if (interaction.isModalSubmit()) {
    if (interaction.customId === 'custom_amount_modal') {
      const amountStr = interaction.fields.getTextInputValue('custom_amount');
      let amount = parseInt(amountStr.replace(/[^0-9]/g, ''));
      
      if (isNaN(amount) || amount < 5000) {
        return interaction.reply({ content: '⚠️ Tối thiểu 5,000đ!', ephemeral: true });
      }
      if (amount > 5000000) {
        return interaction.reply({ content: '⚠️ Tối đa 5,000,000đ!', ephemeral: true });
      }
      
      await interaction.reply({ content: `🔄 Đang tạo mã thanh toán ${amount.toLocaleString()} VND...`, ephemeral: true });
      
      try {
        const orderCode = Number(Date.now());
        const description = `NAP${interaction.user.id.slice(-8)}`;
        const paymentData = await createPaymentLink(orderCode, amount, description, interaction.user.id, interaction.user.username);
        
        pendingPayments.set(orderCode, { userId: interaction.user.id, amount, timestamp: Date.now() });
        
        const qrUrl = `https://img.vietqr.io/image/${paymentData.bin}-${paymentData.accountNumber}-compact.png?amount=${amount}&addInfo=${description}&accountName=${encodeURIComponent(paymentData.accountName)}`;
        
        const embed = new EmbedBuilder()
          .setColor(0xFFA500)
          .setTitle('🧧 NẠP TIỀN')
          .setDescription(`💰 Số tiền: **${amount.toLocaleString()} VND**`)
          .addFields(
            { name: '📝 Nội dung CK', value: `\`${description}\``, inline: true },
            { name: '🏦 Chuyển khoản tới', value: `${paymentData.accountName} - ${paymentData.accountNumber}`, inline: false },
            { name: '⏰ Hết hạn', value: '15 phút', inline: true }
          )
          .setImage(qrUrl)
          .setFooter({ text: 'Quét QR để thanh toán. Bot sẽ tự cộng tiền sau 15-30 giây' })
          .setTimestamp();
        
        await interaction.editReply({ content: null, embeds: [embed] });
        
        // Hẹn giờ tự xóa sau 5 phút
        setTimeout(() => {
          interaction.deleteReply().catch(() => {});
        }, 5 * 60 * 1000);
        
      } catch (error) {
        console.error('PayOS error:', error);
        await interaction.editReply({ 
          content: `❌ Lỗi: ${error.message}`
        });
        setTimeout(() => {
          interaction.deleteReply().catch(() => {});
        }, 15000);
      }
      return;
    }
  }
  
  // BUTTONS
  if (interaction.isButton()) {
    const userId = interaction.user.id;
    
    // Nút mở menu mệnh giá nạp (Riêng tư - Ephemeral, tự xóa sau 5 phút)
    if (interaction.customId === 'nap_menu') {
      const embed = new EmbedBuilder()
        .setColor(0xFFA500)
        .setTitle('💰 NẠP TIỀN ONLINE')
        .setDescription('Chọn số tiền muốn nạp (tối thiểu **5,000đ**):')
        .setTimestamp();
      
      await interaction.reply({ embeds: [embed], components: createNapMenu().components, ephemeral: true });
      
      // Hẹn giờ tự xóa sau 5 phút
      setTimeout(() => {
        interaction.deleteReply().catch(() => {});
      }, 5 * 60 * 1000);
      return;
    }
    
    if (interaction.customId === 'back_to_main_menu') {
      await interaction.deleteReply().catch(() => {});
      return;
    }
    
    if (interaction.customId === 'nap_custom') {
      const modal = new ModalBuilder()
        .setCustomId('custom_amount_modal')
        .setTitle('💰 NHẬP SỐ TIỀN NẠP');
      
      const amountInput = new TextInputBuilder()
        .setCustomId('custom_amount')
        .setLabel('Số tiền (VNĐ)')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('Ví dụ: 50000')
        .setRequired(true);
      
      modal.addComponents(new ActionRowBuilder().addComponents(amountInput));
      await interaction.showModal(modal);
      return;
    }
    
    // Xem số dư (Riêng tư - Ephemeral, tự xóa sau 5 phút)
    if (interaction.customId === 'view_balance') {
      const balance = await db.getBalance(userId);
      const embed = new EmbedBuilder()
        .setColor(0x00FF00)
        .setTitle('💰 SỐ DƯ TÀI KHOẢN')
        .setDescription(`**${balance.toLocaleString()} VND**`)
        .setTimestamp();
      await interaction.reply({ embeds: [embed], ephemeral: true });
      setTimeout(() => {
        interaction.deleteReply().catch(() => {});
      }, 5 * 60 * 1000);
      return;
    }
    
    // Các nút nạp tiền mệnh giá có sẵn (Riêng tư - Ephemeral, tự xóa sau 5 phút)
    if (interaction.customId.startsWith('nap_') && !interaction.customId.includes('custom') && interaction.customId !== 'nap_menu') {
      const amount = parseInt(interaction.customId.split('_')[1]);
      
      if (amount < 5000) {
        return interaction.reply({ content: '⚠️ Tối thiểu 5,000đ!', ephemeral: true });
      }
      
      await interaction.reply({ content: `🔄 Đang tạo mã thanh toán ${amount.toLocaleString()} VND...`, ephemeral: true });
      
      try {
        const orderCode = Number(Date.now());
        const description = `NAP${userId.slice(-8)}`;
        const paymentData = await createPaymentLink(orderCode, amount, description, userId, interaction.user.username);
        
        pendingPayments.set(orderCode, { userId, amount, timestamp: Date.now() });
        
        const qrUrl = `https://img.vietqr.io/image/${paymentData.bin}-${paymentData.accountNumber}-compact.png?amount=${amount}&addInfo=${description}&accountName=${encodeURIComponent(paymentData.accountName)}`;
        
        const embed = new EmbedBuilder()
          .setColor(0xFFA500)
          .setTitle('🧧 NẠP TIỀN')
          .setDescription(`💰 Số tiền: **${amount.toLocaleString()} VND**`)
          .addFields(
            { name: '📝 Nội dung CK', value: `\`${description}\``, inline: true },
            { name: '🏦 Chuyển khoản tới', value: `${paymentData.accountName} - ${paymentData.accountNumber}`, inline: false }
          )
          .setImage(qrUrl)
          .setFooter({ text: 'Quét QR để thanh toán' })
          .setTimestamp();
        
        await interaction.editReply({ content: null, embeds: [embed] });
        
        // Hẹn giờ tự xóa sau 5 phút
        setTimeout(() => {
          interaction.deleteReply().catch(() => {});
        }, 5 * 60 * 1000);
        
      } catch (error) {
        console.error('PayOS error:', error);
        await interaction.editReply({ 
          content: `❌ Lỗi: ${error.message}`
        });
        setTimeout(() => {
          interaction.deleteReply().catch(() => {});
        }, 15000);
      }
      return;
    }
  }
});

process.on('unhandledRejection', (error) => console.error('Unhandled rejection:', error));
client.login(process.env.DISCORD_TOKEN);
