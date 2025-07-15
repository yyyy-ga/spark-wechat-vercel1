import crypto from 'crypto'
import { Client } from '@notionhq/client'
import axios from 'axios'
import xml2js from 'xml2js'

const parser = new xml2js.Parser({ explicitArray: false })
const notion = new Client({ auth: process.env.NOTION_TOKEN })
const deepseekURL = 'https://api.deepseek.com/v1/chat/completions'

function checkSignature(params: any, token: string) {
  const { signature, timestamp, nonce } = params
  const tmpStr = [token, timestamp, nonce].sort().join('')
  const hash = crypto.createHash('sha1').update(tmpStr).digest('hex')
  return hash === signature
}

export default async function handler(req: any, res: any) {
  const { query, method } = req
  const { signature, timestamp, nonce, echostr } = query

  // GET 验证
  if (method === 'GET') {
    return checkSignature(query, process.env.WX_TOKEN!)
      ? res.send(echostr)
      : res.status(403).send('Forbidden')
  }

  // POST
  if (method === 'POST') {
  try {
    const xml = await parser.parseStringPromise(req.body)
    const { MsgType, Content, PicUrl, FromUserName } = xml.xml

    let raw = ''
    if (MsgType === 'text') {
      raw = Content
    } else if (MsgType === 'image') {
      raw = `[图片] ${PicUrl}`   // 只留 url，不下载
    } else if (MsgType === 'link') {
      raw = `[链接] ${xml.xml.Url}` // 如果用户发的是链接
    } else {
      raw = `[暂不支持 ${MsgType} 类型]`
    }

      const prompt = `用竖线"|"分隔：1.10字内标题 2.3个标签逗号分隔 3.分类 4.50字内摘要\n内容：${raw}`

      const { data } = await axios.post(
        deepseekURL,
        {
          model: 'deepseek-chat',
          messages: [{ role: 'user', content: prompt }]
        },
        { headers: { Authorization: `Bearer ${process.env.DEEPSEEK_KEY}` } }
      )

      const [title, tags, category, summary] = data.choices[0].message.content
        .split('|')
        .map((s: string) => s?.trim() ?? '')

      await notion.pages.create({
        parent: { database_id: process.env.NOTION_DATABASE_ID! },
        properties: {
          Title: { title: [{ text: { content: title } }] },
          Tags: { multi_select: tags.split(',').map(t => ({ name: t.trim() })) },
          Category: { select: { name: category } },
          Summary: { rich_text: [{ text: { content: summary } }] },
          Raw: { rich_text: [{ text: { content: raw } }] },
          From: { rich_text: [{ text: { content: FromUserName } }] }
        }
      })

      res.setHeader('Content-Type', 'application/xml')
      return res.send(`
        <xml>
          <ToUserName><![CDATA[${FromUserName}]]></ToUserName>
          <FromUserName><![CDATA[${process.env.WX_GHID}]]></FromUserName>
          <CreateTime>${Math.floor(Date.now() / 1000)}</CreateTime>
          <MsgType><![CDATA[text]]></MsgType>
          <Content><![CDATA[✅ 已保存]]></Content>
        </xml>
      `)
    } catch (e) {
      console.error(e)
      res.setHeader('Content-Type', 'application/xml')
      return res.send(`
        <xml>
          <ToUserName><![CDATA[${xml?.xml?.FromUserName || ''}]]></ToUserName>
          <FromUserName><![CDATA[${process.env.WX_GHID}]]></FromUserName>
          <CreateTime>${Math.floor(Date.now() / 1000)}</CreateTime>
          <MsgType><![CDATA[text]]></MsgType>
          <Content><![CDATA[❌ 保存失败，稍后再试]]></Content>
        </xml>
      `)
    }
  }

  return res.status(405).send('Method Not Allowed')
}

export const config = { api: { bodyParser: false } }
