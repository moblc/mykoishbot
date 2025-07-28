import { Context, Schema, Logger } from 'koishi'
import Imap from 'node-imap'

export const name = 'mailbot'
export const inject = ['database']
export const usage = `
## 使用说明
这是一个邮箱监听插件，用于监听指定邮箱的新邮件并自动通知。

### 主要功能
- 自动监听 IMAP 邮箱
- 新邮件到达时自动发送机器人通知
- 支持多种邮件列表获取方式

### 命令列表
- \`mailbot.start\` - 开始监听新邮件
- \`mailbot.stop\` - 停止监听新邮件  
- \`mailbot.status\` - 查看监听状态
- \`mailbot.list [type]\` - 获取邮件列表 (all/unread/recent)
- \`mailbot.test\` - 测试邮箱连接

### 工作方式
插件启动后会自动开始监听邮箱，当收到新邮件时：
1. 记录详细信息到日志
2. 向所有活跃聊天发送通知消息
`

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
  fetchLimit: number
}

export const Config: Schema<Config> = Schema.object({
  imap: Schema.object({
    host: Schema.string().description('IMAP 服务器地址').default(''),
    port: Schema.number().description('IMAP 服务器端口').default(993),
    user: Schema.string().description('邮箱用户名').default(''),
    password: Schema.string().role('secret').description('邮箱密码').default(''),
    tls: Schema.boolean().description('是否使用 TLS 加密').default(true),
    tlsOptions: Schema.object({
      rejectUnauthorized: Schema.boolean().description('是否验证服务器证书').default(false)
    }).description('TLS 选项').default({ rejectUnauthorized: false })
  }).description('IMAP 服务器配置'),
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

// 邮件监听器状态变量
let imap: Imap | null = null
let isMonitoring = false
let reconnectTimer: NodeJS.Timeout | null = null
let pollTimer: NodeJS.Timeout | null = null
let lastMailCount = 0
let imapConfig: Config['imap'] | null = null
let mailboxName: string = 'INBOX'
let onNewMailCallback: ((messages: any[]) => Promise<void>) | null = null
let lastCheckedUids: Set<number> = new Set() // 记录已处理的邮件UID

// 启动邮件监听
async function startMailMonitor(config: Config['imap'], onNewMail: (messages: any[]) => Promise<void>): Promise<void> {
  if (isMonitoring) {
    logger.warn('邮件监听已在运行中')
    return
  }

  try {
    logger.info('开始邮件监听...')
    imapConfig = config
    onNewMailCallback = onNewMail
    isMonitoring = true
    await connectToMailMonitor()
  } catch (error) {
    logger.error('启动邮件监听失败:', error)
    isMonitoring = false
    throw error
  }
}

// 停止邮件监听
function stopMailMonitor(): void {
  logger.info('停止邮件监听...')
  isMonitoring = false

  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }

  if (pollTimer) {
    clearTimeout(pollTimer)
    pollTimer = null
  }

  if (imap) {
    imap.removeAllListeners()
    try {
      imap.end()
    } catch (err) {
      logger.error('关闭IMAP连接失败:', err)
    }
    imap = null
  }

  // 清除已处理邮件记录
  lastCheckedUids.clear()
}

// 连接到IMAP服务器进行监听
async function connectToMailMonitor(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!imapConfig) {
      return reject(new Error('IMAP配置不存在'))
    }

    imap = new Imap({
      host: imapConfig.host,
      port: imapConfig.port,
      tls: imapConfig.tls,
      tlsOptions: imapConfig.tlsOptions,
      user: imapConfig.user,
      password: imapConfig.password,
      connTimeout: 60000,
      authTimeout: 30000,
      keepalive: {
        interval: 10000,
        idleInterval: 300000,
        forceNoop: true
      }
    })

    imap.once('ready', () => {
      logger.info('邮件监听连接已建立')
      openBoxAndListen(resolve, reject)
    })

    imap.once('error', (err) => {
      logger.error('IMAP监听连接失败:', err.message)
      handleDisconnect()
      reject(err)
    })

    imap.once('end', () => {
      logger.info('IMAP监听连接已断开')
      handleDisconnect()
    })

    imap.connect()
  })
}

// 打开邮箱并开始监听
function openBoxAndListen(resolve: Function, reject: Function): void {
  if (!imap) return reject(new Error('IMAP连接不存在'))

  imap.openBox(mailboxName, false, (err, box) => {
    if (err) {
      logger.error(`打开邮箱 ${mailboxName} 失败:`, err.message)
      return reject(err)
    }

    logger.info(`邮件监听已开启，邮箱: ${mailboxName}, 总邮件数: ${box.messages.total}`)
    lastMailCount = box.messages.total

    // 首次获取未读邮件
    fetchLatestUnread()

    // 监听新邮件事件（作为快速响应机制）
    imap!.on('mail', (numNewMsgs) => {
      logger.info(`📧 IMAP事件: 检测到 ${numNewMsgs} 封新邮件`)
      fetchLatestUnread()
    })

    // 启动定时轮询（作为主要检测机制）
    startPolling()

    resolve(undefined)
  })
}

// 定时轮询检查新邮件
function startPolling(): void {
  if (!isMonitoring) return

  pollTimer = setTimeout(() => {
    if (isMonitoring) {
      logger.debug('🔄 定时轮询检查新邮件...')
      fetchLatestUnread()
      startPolling() // 继续下一次轮询
    }
  }, 10000) // 每30秒检查一次
}

// 获取最新未读邮件
function fetchLatestUnread(): void {
  if (!imap || !isMonitoring) return

  imap.search(['UNSEEN'], (err, results) => {
    if (err) {
      logger.error('搜索未读邮件失败:', err.message)
      return
    }

    if (!results || results.length === 0) {
      logger.debug('📭 当前没有未读邮件')
      return
    }

    logger.info(`📬 找到 ${results.length} 封未读邮件`)

    // 过滤出新的邮件（未处理过的UID）
    const newUids = results.filter(uid => !lastCheckedUids.has(uid))

    if (newUids.length === 0) {
      logger.debug('📋 所有未读邮件都已处理过')
      return
    }

    logger.info(`🆕 发现 ${newUids.length} 封新邮件，准备获取详情`)

    // 只获取新邮件
    const fetch = imap!.fetch(newUids, {
      bodies: ['HEADER.FIELDS (FROM TO SUBJECT DATE MESSAGE-ID)', 'TEXT'],
      struct: true,
      markSeen: false // 不自动标记为已读
    })

    const messages: any[] = []

    fetch.on('message', (msg, seqno) => {
      const messageData: any = { seqno, isNew: true }

      msg.on('body', (stream, info) => {
        let buffer = ''
        stream.on('data', (chunk) => {
          buffer += chunk.toString('utf8')
        })
        stream.once('end', () => {
          if (info.which === 'HEADER.FIELDS (FROM TO SUBJECT DATE MESSAGE-ID)') {
            // 处理邮件头部
            const parsed = Imap.parseHeader(buffer)
            messageData.headers = {
              from: parsed.from?.[0] || '未知发件人',
              to: parsed.to?.[0] || '未知收件人',
              subject: parsed.subject?.[0] || '无主题',
              date: parsed.date?.[0] || '未知日期',
              messageId: parsed['message-id']?.[0] || ''
            }
          } else if (info.which === 'TEXT') {
            // 处理邮件正文
            messageData.bodyText = buffer.trim()
          }
        })
      })

      msg.once('attributes', (attrs) => {
        messageData.attributes = attrs
        messageData.uid = attrs.uid
        messageData.flags = attrs.flags

        // 记录已处理的UID
        lastCheckedUids.add(attrs.uid)
      })

      msg.once('end', () => {
        messages.push(messageData)
      })
    })

    fetch.once('error', (err) => {
      logger.error('获取未读邮件失败:', err.message)
    })

    fetch.once('end', () => {
      if (messages.length > 0) {
        messages.sort((a, b) => b.seqno - a.seqno)
        logger.info(`✅ 成功获取 ${messages.length} 封新邮件，准备通知`)
        if (onNewMailCallback) {
          onNewMailCallback(messages).catch(err => {
            logger.error('处理新邮件回调失败:', err)
          })
        }
      }
    })
  })
}

// 处理连接断开
function handleDisconnect(): void {
  if (!isMonitoring) return

  logger.warn('IMAP连接断开，将在30秒后尝试重连...')

  if (imap) {
    imap.removeAllListeners()
    imap = null
  }

  reconnectTimer = setTimeout(() => {
    if (isMonitoring) {
      logger.info('尝试重新连接IMAP...')
      connectToMailMonitor().catch(err => {
        logger.error('重连失败:', err.message)
      })
    }
  }, 10000)
}

// 获取监听状态
function getMonitorStatus(): { isMonitoring: boolean; lastMailCount: number } {
  return {
    isMonitoring: isMonitoring,
    lastMailCount: lastMailCount
  }
}

// 删除邮件函数
function deleteEmailByUid(uid: number): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!imap || !isMonitoring) {
      return reject(new Error('IMAP连接不可用'))
    }

    // 标记邮件为删除
    imap.addFlags(uid, ['\\Deleted'], (err) => {
      if (err) {
        logger.error(`标记邮件删除失败 (UID: ${uid}):`, err.message)
        return reject(err)
      }

      logger.debug(`📌 邮件已标记为删除 (UID: ${uid})`)

      // 执行 expunge 操作永久删除
      imap.expunge((expungeErr) => {
        if (expungeErr) {
          logger.error(`执行邮件删除失败 (UID: ${uid}):`, expungeErr.message)
          return reject(expungeErr)
        }

        logger.info(`🗑️ 邮件已删除 (UID: ${uid})`)
        resolve()
      })
    })
  })
}
function getMailList(imap: Imap, mailbox: string, limit: number): Promise<any[]> {
  return new Promise((resolve, reject) => {
    imap.openBox(mailbox, true, (err, box) => {
      if (err) {
        logger.error(`打开邮箱 ${mailbox} 失败:`, err.message)
        return reject(err)
      }

      logger.info(`成功打开邮箱: ${mailbox} (只读模式), 总邮件数: ${box.messages.total}`)
      logger.info(`邮箱状态: 未读=${box.messages.unseen}, 最近=${box.messages.recent}`)
      logger.info(`邮箱权限: ${box.readOnly ? '只读' : '读写'}`)

      if (box.messages.total === 0) {
        logger.info('邮箱中没有邮件，返回空列表')
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

// 搜索邮件函数 (支持不同搜索条件)
function searchMails(imap: Imap, mailbox: string, criteria: string[], limit: number): Promise<any[]> {
  return new Promise((resolve, reject) => {
    imap.openBox(mailbox, true, (err, box) => {
      if (err) {
        logger.error(`打开邮箱 ${mailbox} 失败:`, err.message)
        return reject(err)
      }

      logger.info(`搜索邮件 - 邮箱: ${mailbox}, 条件: ${criteria.join(', ')}, 总邮件数: ${box.messages.total}`)

      if (box.messages.total === 0) {
        logger.info('邮箱中没有邮件')
        return resolve([])
      }

      imap.search(criteria, (err, results) => {
        if (err) {
          logger.error('搜索邮件失败:', err.message)
          return reject(err)
        }

        if (!results || results.length === 0) {
          logger.info(`搜索条件 ${criteria.join(', ')} 没有找到匹配的邮件`)
          return resolve([])
        }

        logger.info(`搜索到 ${results.length} 封匹配邮件`)

        // 限制结果数量，取最新的
        const limitedResults = results.slice(-limit)

        const fetch = imap.fetch(limitedResults, {
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
          logger.error('获取搜索结果失败:', err.message)
          reject(err)
        })

        fetch.once('end', () => {
          logger.info(`成功获取 ${messages.length} 封搜索邮件`)
          // 按UID排序，最新的在前
          messages.sort((a, b) => b.uid - a.uid)
          resolve(messages)
        })
      })
    })
  })
}

export function apply(ctx: Context, config: Config) {
  // 检查配置完整性
  const isConfigured = () => {
    return config.imap.host && config.imap.user && config.imap.password
  }

  // 邮件监听器状态管理变量（不再使用类）
  // let mailMonitor: MailMonitor | null = null - 已移除类实现

  // 新邮件通知处理函数
  const handleNewMail = async (messages: any[]) => {
    for (const msg of messages) {
      const { headers } = msg

      // 记录详细的新邮件信息到日志
      logger.info(`📮 收到新邮件！`)
      logger.info(`📤 发件人: ${headers.from}`)
      logger.info(`📋 主题: ${headers.subject}`)
      logger.info(`📅 时间: ${headers.date}`)
      logger.info(`🆔 UID: ${msg.uid}`)

      logger.info(`✨ 新邮件已记录: ${headers.subject}`)

      // 处理邮件正文内容
      let contentPreview = ''
      if (msg.bodyText) {
        // 清理正文内容，去除多余的空白字符
        const cleanText = msg.bodyText.replace(/\s+/g, ' ').trim()
        // 限制预览长度为200字符
        contentPreview = cleanText.length > 200
          ? cleanText.substring(0, 200) + '...'
          : cleanText
      }

      // 发送机器人通知消息
      let notificationMsg = `📮 收到新邮件！\n` +
        `📤 发件人: ${headers.from}\n` +
        `📋 主题: ${headers.subject}\n` +
        `📅 时间: ${headers.date}`

      // 如果有正文内容，则添加到通知中
      if (contentPreview) {
        notificationMsg += `\n📄 内容: ${contentPreview}`
      }

      try {
        // 广播新邮件通知到所有活跃会话
        ctx.broadcast(notificationMsg)
        logger.info(`📢 邮件通知已发送: ${headers.subject}`)

        // 通知成功后删除邮件
        try {
          await deleteEmailByUid(msg.uid)
          logger.info(`✅ 邮件已处理并删除: ${headers.subject} (UID: ${msg.uid})`)
        } catch (deleteError) {
          logger.error(`删除邮件失败 (UID: ${msg.uid}):`, deleteError.message)
          logger.warn(`邮件通知已发送但删除失败，可能会重复通知: ${headers.subject}`)
        }
      } catch (error) {
        logger.error('发送邮件通知失败:', error)
        logger.warn(`邮件通知失败，不删除邮件: ${headers.subject} (UID: ${msg.uid})`)
      }
    }
  }

  // 注册启动监听命令
  ctx.command('mailbot.start', '开始监听新邮件')
    .action(async ({ session }) => {
      if (!isConfigured()) {
        return '❌ 请先在插件配置中设置邮箱账户信息\n' +
          '需要配置：IMAP服务器地址、用户名、密码'
      }

      if (getMonitorStatus().isMonitoring) {
        return '📧 邮件监听已在运行中'
      }

      try {
        session.send('🚀 正在启动邮件监听...')

        await startMailMonitor(config.imap, handleNewMail)

        return '✅ 邮件监听已启动！新邮件到达时会自动通知。'

      } catch (error) {
        logger.error('启动邮件监听失败:', error)
        return `❌ 启动邮件监听失败: ${error.message}`
      }
    })

  // 注册停止监听命令
  ctx.command('mailbot.stop', '停止监听新邮件')
    .action(async ({ session }) => {
      if (!getMonitorStatus().isMonitoring) {
        return '📭 邮件监听当前未运行'
      }

      try {
        stopMailMonitor()
        return '⏹️ 邮件监听已停止'

      } catch (error) {
        logger.error('停止邮件监听失败:', error)
        return `❌ 停止邮件监听失败: ${error.message}`
      }
    })

  // 注册监听状态查询命令
  ctx.command('mailbot.status', '查看邮件监听状态')
    .action(async ({ session }) => {
      if (!isConfigured()) {
        return '❌ 邮箱配置未完成'
      }

      const status = getMonitorStatus()
      if (!status.isMonitoring) {
        return '📭 邮件监听当前未运行\n使用 mailbot.start 开始监听'
      }

      return `📧 邮件监听运行中\n` +
        `📮 邮箱: INBOX\n` +
        `� 新邮件将记录到日志中`
    })
  ctx.command('mailbot.list [type]', '获取邮箱邮件列表')
    .example('mailbot.list all      # 获取所有邮件')
    .example('mailbot.list unread   # 获取未读邮件')
    .example('mailbot.list recent   # 获取最近邮件')
    .action(async ({ session }, type = 'all') => {
      if (!isConfigured()) {
        return '❌ 请先在插件配置中设置邮箱账户信息\n' +
          '需要配置：IMAP服务器地址、用户名、密码'
      }

      let imap: Imap | null = null

      try {
        session.send('📧 正在连接邮箱服务器...')

        // 连接到IMAP服务器
        imap = await connectToImap(config.imap)

        session.send(`📬 正在获取邮件列表 (${type})...`)

        let messages: any[] = []
        let typeDesc = ''

        // 根据选项选择获取方式
        switch (type) {
          case 'unread':
            messages = await searchMails(imap, 'INBOX', ['UNSEEN'], config.fetchLimit)
            typeDesc = '未读'
            break
          case 'recent':
            messages = await searchMails(imap, 'INBOX', ['RECENT'], config.fetchLimit)
            typeDesc = '最近'
            break
          case 'all':
          default:
            // 尝试搜索所有邮件，如果失败则使用原来的序号方式
            try {
              messages = await searchMails(imap, 'INBOX', ['ALL'], config.fetchLimit)
              typeDesc = '所有'
            } catch (searchError) {
              logger.warn('搜索所有邮件失败，尝试使用序号方式:', searchError.message)
              messages = await getMailList(imap, 'INBOX', config.fetchLimit)
              typeDesc = '所有(序号方式)'
            }
            break
        }

        if (messages.length === 0) {
          return `📭 邮箱 "INBOX" 中没有${typeDesc}邮件\n` +
            `💡 提示: 可以尝试其他类型:\n` +
            `   mailbot.list -t unread  (未读邮件)\n` +
            `   mailbot.list -t recent  (最近邮件)\n` +
            `   mailbot.list -t all     (所有邮件)`
        }

        // 格式化邮件列表
        let result = `📮 邮箱 "INBOX" 中的${typeDesc}邮件 (${messages.length} 封):\n\n`

        messages.forEach((msg, index) => {
          const { headers } = msg
          const isUnread = !msg.flags.includes('\\Seen') ? '🆕 ' : ''
          const isRecent = msg.flags.includes('\\Recent') ? '🔥 ' : ''

          result += `${index + 1}. ${isUnread}${isRecent}${headers.subject}\n`
          result += `   📤 发件人: ${headers.from}\n`
          result += `   📅 日期: ${headers.date}\n`
          result += `   🆔 UID: ${msg.uid}\n\n`
        })

        return result.trim()

      } catch (error) {
        logger.error('获取邮件列表失败:', error)
        return `❌ 获取邮件列表失败: ${error.message}\n` +
          `💡 可以尝试: mailbot.test 测试连接`
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
      if (!isConfigured()) {
        return '❌ 请先在插件配置中设置邮箱账户信息\n' +
          '需要配置：IMAP服务器地址、用户名、密码'
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

  // 插件启动时检查配置和自动启动监听
  if (isConfigured()) {
    logger.info('Mailbot 插件已启动，邮箱配置已完成')

    // 默认启动邮件监听
    logger.info('自动启动邮件监听...')
    setTimeout(async () => {
      try {
        await startMailMonitor(config.imap, handleNewMail)
        logger.info('邮件监听自动启动成功')
      } catch (error) {
        logger.error('邮件监听自动启动失败:', error)
      }
    }, 5000) // 延迟5秒启动，确保插件完全加载
  } else {
    logger.warn('Mailbot 插件已启动，但邮箱配置未完成，请在配置中设置 IMAP 服务器信息')
  }

  // 插件卸载时清理资源
  ctx.on('dispose', () => {
    if (getMonitorStatus().isMonitoring) {
      logger.info('插件卸载，停止邮件监听')
      stopMailMonitor()
    }
  })
}