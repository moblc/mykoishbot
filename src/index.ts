import { Context, Schema, Logger } from 'koishi'
import * as Imap from 'node-imap'

export const name = 'mailbot'

// 创建日志器
const logger = new Logger('mailbot')

export interface Config {
  imap: {
    host: string
    port: number
    user: string
    password: string
    tls: boolean
    tlsOptions?: {
      rejectUnauthorized: boolean
    }
  }
  mailbox: string
  fetchLimit: number
}

export const Config: Schema<Config> = Schema.object({
  imap: Schema.object({
    host: Schema.string().description('IMAP 服务器地址').required(),
    port: Schema.number().description('IMAP 服务器端口').default(993),
    user: Schema.string().description('邮箱用户名').required(),
    password: Schema.string().role('secret').description('邮箱密码').required(),
    tls: Schema.boolean().description('是否使用 TLS 加密').default(true),
    tlsOptions: Schema.object({
      rejectUnauthorized: Schema.boolean().description('是否验证服务器证书').default(false)
    }).description('TLS 选项').default({ rejectUnauthorized: false })
  }).description('IMAP 服务器配置'),
  mailbox: Schema.string().description('要读取的邮箱文件夹').default('INBOX'),
  fetchLimit: Schema.number().description('每次获取邮件数量限制').default(10).min(1).max(50)
})

// IMAP 连接函数
function connectToImap(config: Config['imap']): Promise<Imap> {
  return new Promise((resolve, reject) => {
    const imap = new Imap({
      host: config.host,
      port: config.port,
      tls: config.tls,
      tlsOptions: config.tlsOptions,
      user: config.user,
      password: config.password,
      connTimeout: 60000, // 60秒连接超时
      authTimeout: 30000, // 30秒认证超时
      keepalive: false
    })

    imap.once('ready', () => {
      logger.info('IMAP 连接已建立')
      resolve(imap)
    })

    imap.once('error', (err) => {
      logger.error('IMAP 连接失败:', err.message)
      reject(err)
    })

    imap.once('end', () => {
      logger.info('IMAP 连接已断开')
    })

    try {
      imap.connect()
    } catch (err) {
      reject(err)
    }
  })
}

// 获取邮件列表函数
function getMailList(imap: Imap, mailbox: string, limit: number): Promise<any[]> {
  return new Promise((resolve, reject) => {
    imap.openBox(mailbox, true, (err, box) => {
      if (err) {
        logger.error(`打开邮箱 ${mailbox} 失败:`, err.message)
        return reject(err)
      }

      logger.info(`成功打开邮箱: ${mailbox}, 总邮件数: ${box.messages.total}`)

      if (box.messages.total === 0) {
        return resolve([])
      }

      // 计算要获取的邮件范围
      const total = box.messages.total
      const start = Math.max(1, total - limit + 1)
      const end = total
      const range = `${start}:${end}`

      logger.info(`获取邮件范围: ${range}`)

      const fetch = imap.fetch(range, {
        bodies: 'HEADER.FIELDS (FROM TO SUBJECT DATE MESSAGE-ID)',
        struct: true
      })

      const messages: any[] = []

      fetch.on('message', (msg, seqno) => {
        const messageData: any = { seqno }

        msg.on('body', (stream, info) => {
          let buffer = ''
          stream.on('data', (chunk) => {
            buffer += chunk.toString('utf8')
          })
          stream.once('end', () => {
            const parsed = Imap.parseHeader(buffer)
            messageData.headers = {
              from: parsed.from?.[0] || '未知发件人',
              to: parsed.to?.[0] || '未知收件人',
              subject: parsed.subject?.[0] || '无主题',
              date: parsed.date?.[0] || '未知日期',
              messageId: parsed['message-id']?.[0] || ''
            }
          })
        })

        msg.once('attributes', (attrs) => {
          messageData.attributes = attrs
          messageData.uid = attrs.uid
          messageData.flags = attrs.flags
        })

        msg.once('end', () => {
          messages.push(messageData)
        })
      })

      fetch.once('error', (err) => {
        logger.error('获取邮件失败:', err.message)
        reject(err)
      })

      fetch.once('end', () => {
        logger.info(`成功获取 ${messages.length} 封邮件`)
        // 按序号排序，最新的在前
        messages.sort((a, b) => b.seqno - a.seqno)
        resolve(messages)
      })
    })
  })
}

export function apply(ctx: Context, config: Config) {
  // 注册获取邮件列表命令
  ctx.command('mailbot.list', '获取邮箱邮件列表')
    .action(async ({ session }) => {
      if (!config.imap.host || !config.imap.user || !config.imap.password) {
        return '❌ 请先在插件配置中设置邮箱账户信息'
      }

      let imap: Imap | null = null

      try {
        session.send('📧 正在连接邮箱服务器...')

        // 连接到IMAP服务器
        imap = await connectToImap(config.imap)

        session.send('📬 正在获取邮件列表...')

        // 获取邮件列表
        const messages = await getMailList(imap, config.mailbox, config.fetchLimit)

        if (messages.length === 0) {
          return `📭 邮箱 "${config.mailbox}" 中没有邮件`
        }

        // 格式化邮件列表
        let result = `📮 邮箱 "${config.mailbox}" 中的邮件列表 (最近 ${messages.length} 封):\n\n`

        messages.forEach((msg, index) => {
          const { headers } = msg
          const isUnread = !msg.flags.includes('\\Seen') ? '🆕 ' : ''

          result += `${index + 1}. ${isUnread}${headers.subject}\n`
          result += `   📤 发件人: ${headers.from}\n`
          result += `   📅 日期: ${headers.date}\n`
          result += `   🆔 UID: ${msg.uid}\n\n`
        })

        return result.trim()

      } catch (error) {
        logger.error('获取邮件列表失败:', error)
        return `❌ 获取邮件列表失败: ${error.message}`
      } finally {
        // 确保关闭IMAP连接
        if (imap) {
          try {
            imap.end()
          } catch (err) {
            logger.error('关闭IMAP连接失败:', err)
          }
        }
      }
    })

  // 注册测试连接命令
  ctx.command('mailbot.test', '测试邮箱连接')
    .action(async ({ session }) => {
      if (!config.imap.host || !config.imap.user || !config.imap.password) {
        return '❌ 请先在插件配置中设置邮箱账户信息'
      }

      let imap: Imap | null = null

      try {
        session.send('🔧 正在测试邮箱连接...')

        // 测试连接
        imap = await connectToImap(config.imap)

        return `✅ 邮箱连接测试成功！\n服务器: ${config.imap.host}:${config.imap.port}\n用户: ${config.imap.user}`

      } catch (error) {
        logger.error('邮箱连接测试失败:', error)
        return `❌ 邮箱连接测试失败: ${error.message}`
      } finally {
        // 确保关闭IMAP连接
        if (imap) {
          try {
            imap.end()
          } catch (err) {
            logger.error('关闭IMAP连接失败:', err)
          }
        }
      }
    })

  // 保留原有的测试中间件
  ctx.middleware((session, next) => {
    if (session.content === '天王盖地虎') {
      return '宝塔镇河妖'
    } else {
      return next()
    }
  })

  logger.info('Mailbot 插件已启动')
}