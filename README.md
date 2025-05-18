# Gemini Chat

一个基于Google Gemini API的简洁聊天界面，支持文本和图像输入。

## 特点

- 响应式设计，适配移动端和桌面端
- 支持多种API设置和模型选择
- 深色/浅色主题切换
- 聊天样式自定义
- 支持图片上传和识别
- 支持直接粘贴或拖放图片
- 支持图片压缩和质量控制
- 支持聊天历史导入导出
- 系统提示词模板支持

## 使用方法

1. 访问应用并在设置中输入您的Gemini API密钥
2. 验证密钥后选择适合的模型
3. 开始与Gemini交流，可以发送文本或图片
4. 通过设置菜单调整各项参数

## 本地部署

直接在任何静态Web服务器上托管即可，也可以使用以下命令进行本地开发：

```bash
# 使用Python的HTTP服务器（Python 3）
python -m http.server 8000

# 或使用Node.js的http-server
npx http-server
```

## 授权

MIT License 