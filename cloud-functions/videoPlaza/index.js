/**
 * videoPlaza 云函数
 *
 * 视频广场功能服务
 * - 获取/管理公共授权教学视频
 * - 分类筛选和排序
 * - 点赞/收藏/评论
 * - 教练信息管理
 * - 播放计数
 */

const cloudbase = require('@cloudbase/node-sdk');
const crypto = require('crypto');
const https = require('https');
const nodemailer = require('nodemailer');

const app = cloudbase.init({
    env: process.env.TCB_ENV || 'mygolfswingapp-9g2izywqa8ac3f5b'
});

const db = app.database();
const _ = db.command;

const mailTransporter = nodemailer.createTransport({
    host: 'smtp.163.com',
    port: 465,
    secure: true,
    auth: {
        user: process.env.MAIL_USER || '',
        pass: process.env.MAIL_PASS || ''
    }
});
const ADMIN_EMAIL = '372931693@qq.com';

const COLLECTIONS = {
    VIDEOS: 'plaza_videos',
    COACHES: 'plaza_coaches',
    CATEGORIES: 'plaza_categories',
    LIKES: 'plaza_likes',
    FAVORITES: 'plaza_favorites',
    COMMENTS: 'plaza_comments',
    REPORTS: 'plaza_reports',
    CLAIMS: 'plaza_claims',
    AUTO_FILL: 'plaza_auto_fill',
};

const AUTO_FILL_DOC_ID = 'config';
const AUTO_FILL_DEFAULTS = {
    publishIntervalHours: 4,
    videosPerRound: 1,
};

// 管理员密钥（CloudBase 云函数环境变量中配置）
const ADMIN_KEY = process.env.PLAZA_ADMIN_KEY || process.env.ADMIN_KEY || '';

// 腾讯云 VOD API 凭证（在 CloudBase 控制台 -> 云函数 -> 环境变量中配置）
const VOD_SECRET_ID = process.env.VOD_SECRET_ID || '';
const VOD_SECRET_KEY = process.env.VOD_SECRET_KEY || '';
const VOD_REGION = process.env.VOD_REGION || 'ap-guangzhou';
const TENCENT_SECRET_ID = process.env.TENCENT_SECRET_ID || VOD_SECRET_ID;
const TENCENT_SECRET_KEY = process.env.TENCENT_SECRET_KEY || VOD_SECRET_KEY;
const TIKHUB_TOKEN = process.env.TIKHUB_TOKEN || '';
const TIKHUB_BASE = process.env.TIKHUB_BASE || 'https://api.tikhub.io';

/**
 * 云函数入口
 */
exports.main = async (event, context) => {
    let params;
    if (typeof event.body === 'string') {
        try {
            params = JSON.parse(event.body);
        } catch {
            params = event;
        }
    } else {
        params = event;
    }

    const { action, ...restParams } = params;
    console.log('[VideoPlaza] action=' + action);

    try {
        switch (action) {
            case 'initDatabase':
                return await initDatabase();
            case 'getPlazaVideos':
                return await getPlazaVideos(restParams);
            case 'getVideoDetail':
                return await getVideoDetail(restParams);
            case 'getCoachProfile':
                return await getCoachProfile(restParams);
            case 'likeVideo':
                return await likeVideo(restParams);
            case 'unlikeVideo':
                return await unlikeVideo(restParams);
            case 'favoriteVideo':
                return await favoriteVideo(restParams);
            case 'unfavoriteVideo':
                return await unfavoriteVideo(restParams);
            case 'getComments':
                return await getComments(restParams);
            case 'addComment':
                return await addComment(restParams);
            case 'reportComment':
                return await reportComment(restParams);
            case 'reportVideo':
                return await reportVideo(restParams);
            case 'claimVideo':
                return await claimVideo(restParams);
            case 'getCategories':
                return await getCategories();
            case 'getCoaches':
                return await getCoaches();
            case 'getAutoFillConfig':
                return await getAutoFillConfig();
            case 'setAutoFillConfig':
                return await requireAdmin(restParams, setAutoFillConfig);
            case 'incrementViewCount':
                return await incrementViewCount(restParams);
            case 'addVideo':
                return await addVideo(restParams);
            case 'uploadVideo':
                return await uploadVideo(restParams);
            case 'testApplyUpload':
                return await testApplyUpload(restParams);
            case 'addCoach':
                return await addCoach(restParams);
            case 'getCoachesByCategory':
                return await getCoachesByCategory(restParams);

            // ===== VOD 元数据查询 =====
            case 'getVodMediaInfo':
                return await requireAdmin(restParams, getVodMediaInfo);
            case 'getBillingDashboard':
                return await requireAdmin(restParams, getBillingDashboard);
            case 'resolveCoachSource':
                return await requireAdmin(restParams, resolveCoachSource);

            // ===== 管理后台接口（需要 adminKey） =====
            case 'adminAuth':
                return adminAuth(restParams);
            case 'adminListVideos':
                return await requireAdmin(restParams, adminListVideos);
            case 'updateVideo':
                return await requireAdmin(restParams, updateVideo);
            case 'deleteVideo':
                return await requireAdmin(restParams, deleteVideo);
            case 'adminListCoaches':
                return await requireAdmin(restParams, adminListCoaches);
            case 'updateCoach':
                return await requireAdmin(restParams, updateCoach);
            case 'deleteCoach':
                return await requireAdmin(restParams, deleteCoach);
            case 'uploadCoachImage':
                return await requireAdmin(restParams, uploadCoachImage);
            case 'rebuildSearchIndex':
                return await requireAdmin(restParams, rebuildSearchIndex);
            case 'addCategory':
                return await requireAdmin(restParams, addCategory);
            case 'updateCategory':
                return await requireAdmin(restParams, updateCategory);
            case 'deleteCategory':
                return await requireAdmin(restParams, deleteCategory);
            case 'migrateAddNewFields':
                return await requireAdmin(restParams, migrateAddNewFields);
            case 'migrateBackfillVodFileIds':
                return await requireAdmin(restParams, migrateBackfillVodFileIds);
            case 'batchDeleteVideos':
                return await requireAdmin(restParams, batchDeleteVideos);
            case 'batchFillCovers':
                return await requireAdmin(restParams, batchFillCovers);
            case 'getDataHealthReport':
                return await requireAdmin(restParams, getDataHealthReport);
            default:
                return { success: false, error: 'Unknown action: ' + action };
        }
    } catch (error) {
        console.error('[VideoPlaza] Error:', error);
        return {
            success: false,
            error: error.message || '服务器内部错误',
            statusCode: 500
        };
    }
};

// ============================================================
// 数据库初始化
// ============================================================

async function initDatabase() {
    const collections = Object.values(COLLECTIONS);
    const results = [];

    for (const name of collections) {
        try {
            await db.createCollection(name);
            results.push({ collection: name, status: 'created' });
        } catch (e) {
            if (e.code === 'DATABASE_COLLECTION_EXIST') {
                results.push({ collection: name, status: 'already_exists' });
            } else {
                results.push({ collection: name, status: 'error', error: e.message });
            }
        }
    }

    return { success: true, results };
}

// ============================================================
// 视频列表
// ============================================================

async function getPlazaVideos({ categoryId, parentCategoryId, coachId, keyword, sortBy = 'popular', limit = 20, offset = 0, userId }) {
    const whereClause = { isAuthorized: true, deleted: _.neq(true) };

    if (parentCategoryId) {
        whereClause.parentCategoryId = parentCategoryId;
    } else if (categoryId) {
        whereClause.categoryId = categoryId;
    }
    if (coachId) {
        whereClause.coachId = coachId;
    }
    if (keyword && keyword.trim()) {
        whereClause.searchText = db.RegExp({
            regexp: escapeRegExp(keyword.trim()),
            options: 'i'
        });
    }

    let query = db.collection(COLLECTIONS.VIDEOS).where(whereClause);

    let orderField = 'stats.score';
    let orderDir = 'desc';
    if (sortBy === 'latest') {
        orderField = 'publishTime';
    } else if (sortBy === 'mostFavorited') {
        orderField = 'stats.favorites';
    }

    let dbQuery = query.orderBy(orderField, orderDir);
    if (sortBy === 'popular') {
        dbQuery = dbQuery.orderBy('stats.views', 'desc');
    }
    const { data: videos } = await dbQuery
        .skip(offset)
        .limit(limit)
        .get();

    // 如果用户已登录，附加点赞/收藏状态
    if (userId) {
        for (const video of videos) {
            const { data: likeData } = await db.collection(COLLECTIONS.LIKES)
                .where({ videoId: video.videoId, userId })
                .limit(1)
                .get();
            video.isLikedByMe = likeData.length > 0;

            const { data: favData } = await db.collection(COLLECTIONS.FAVORITES)
                .where({ videoId: video.videoId, userId })
                .limit(1)
                .get();
            video.isFavoritedByMe = favData.length > 0;
        }
    }

    return { success: true, videos };
}

// ============================================================
// 视频详情
// ============================================================

async function getVideoDetail({ videoId, userId }) {
    const { data } = await db.collection(COLLECTIONS.VIDEOS)
        .where({ videoId, deleted: _.neq(true) })
        .limit(1)
        .get();

    if (data.length === 0) {
        return { success: false, error: '视频不存在' };
    }

    const video = data[0];

    if (userId) {
        const { data: likeData } = await db.collection(COLLECTIONS.LIKES)
            .where({ videoId, userId })
            .limit(1)
            .get();
        video.isLikedByMe = likeData.length > 0;

        const { data: favData } = await db.collection(COLLECTIONS.FAVORITES)
            .where({ videoId, userId })
            .limit(1)
            .get();
        video.isFavoritedByMe = favData.length > 0;
    }

    return { success: true, video };
}

// ============================================================
// 教练信息
// ============================================================

async function getCoachProfile({ coachId }) {
    // 先精确匹配
    let { data } = await db.collection(COLLECTIONS.COACHES)
        .where({ id: coachId })
        .limit(1)
        .get();

    // 精确匹配失败时，尝试忽略大小写匹配
    if (data.length === 0) {
        const result = await db.collection(COLLECTIONS.COACHES)
            .where({ id: db.RegExp({ regexp: `^${escapeRegExp(coachId)}$`, options: 'i' }) })
            .limit(1)
            .get();
        data = result.data;
    }

    if (data.length === 0) {
        return { success: false, error: '教练不存在' };
    }

    return { success: true, coach: data[0] };
}

// ============================================================
// 点赞
// ============================================================

async function likeVideo({ videoId, userId }) {
    const { data: existing } = await db.collection(COLLECTIONS.LIKES)
        .where({ videoId, userId })
        .limit(1)
        .get();

    if (existing.length > 0) {
        return { success: true, message: '已点赞' };
    }

    await db.collection(COLLECTIONS.LIKES).add({
        videoId,
        userId,
        createdAt: new Date()
    });

    await db.collection(COLLECTIONS.VIDEOS)
        .where({ videoId })
        .update({ 'stats.likes': _.inc(1) });

    await updateScore(videoId);
    return { success: true };
}

async function unlikeVideo({ videoId, userId }) {
    const { data: existing } = await db.collection(COLLECTIONS.LIKES)
        .where({ videoId, userId })
        .limit(1)
        .get();

    if (existing.length === 0) {
        return { success: true, message: '未点赞，无需取消' };
    }

    await db.collection(COLLECTIONS.LIKES)
        .where({ videoId, userId })
        .remove();

    await db.collection(COLLECTIONS.VIDEOS)
        .where({ videoId })
        .update({ 'stats.likes': _.inc(-1) });

    await updateScore(videoId);
    return { success: true };
}

// ============================================================
// 收藏
// ============================================================

async function favoriteVideo({ videoId, userId }) {
    const { data: existing } = await db.collection(COLLECTIONS.FAVORITES)
        .where({ videoId, userId })
        .limit(1)
        .get();

    if (existing.length > 0) {
        return { success: true, message: '已收藏' };
    }

    await db.collection(COLLECTIONS.FAVORITES).add({
        videoId,
        userId,
        createdAt: new Date()
    });

    await db.collection(COLLECTIONS.VIDEOS)
        .where({ videoId })
        .update({ 'stats.favorites': _.inc(1) });

    await updateScore(videoId);
    return { success: true };
}

async function unfavoriteVideo({ videoId, userId }) {
    const { data: existing } = await db.collection(COLLECTIONS.FAVORITES)
        .where({ videoId, userId })
        .limit(1)
        .get();

    if (existing.length === 0) {
        return { success: true, message: '未收藏，无需取消' };
    }

    await db.collection(COLLECTIONS.FAVORITES)
        .where({ videoId, userId })
        .remove();

    await db.collection(COLLECTIONS.VIDEOS)
        .where({ videoId })
        .update({ 'stats.favorites': _.inc(-1) });

    await updateScore(videoId);
    return { success: true };
}

// ============================================================
// 评论
// ============================================================

async function getComments({ videoId, limit = 20, offset = 0 }) {
    const { data: comments } = await db.collection(COLLECTIONS.COMMENTS)
        .where({ videoId })
        .orderBy('createdAt', 'desc')
        .skip(offset)
        .limit(limit)
        .get();

    return { success: true, comments };
}

async function addComment({ videoId, userId, userName, userAvatar, content }) {
    if (!content || content.trim().length === 0) {
        return { success: false, error: '评论内容不能为空' };
    }
    if (content.length > 200) {
        return { success: false, error: '评论最多200字' };
    }

    const commentId = generateUUID();
    const comment = {
        id: commentId,
        videoId,
        userId,
        userName: userName || '用户',
        userAvatar: userAvatar || '',
        content: content.trim(),
        createdAt: Date.now()
    };

    await db.collection(COLLECTIONS.COMMENTS).add(comment);

    await db.collection(COLLECTIONS.VIDEOS)
        .where({ videoId })
        .update({ 'stats.comments': _.inc(1) });

    await updateScore(videoId);
    return { success: true, comment };
}

// ============================================================
// 举报
// ============================================================

async function reportComment({ commentId, videoId, userId, reason }) {
    if (!commentId || !videoId || !userId) {
        return { success: false, error: '缺少必要参数' };
    }

    const { data: existing } = await db.collection(COLLECTIONS.REPORTS)
        .where({ commentId, userId })
        .limit(1)
        .get();

    if (existing.length > 0) {
        return { success: true, message: '已举报，请勿重复提交' };
    }

    await db.collection(COLLECTIONS.REPORTS).add({
        reportId: generateUUID(),
        commentId,
        videoId,
        userId,
        reason: reason || '用户举报',
        status: 'pending',
        createdAt: new Date()
    });

    return { success: true, message: '举报已提交' };
}

async function reportVideo({ videoId, userId, reason, reasonText, detail, priority }) {
    if (!videoId || !userId || !reason) {
        return { success: false, error: '缺少必要参数' };
    }

    try {
        const { data: existing } = await db.collection(COLLECTIONS.REPORTS)
            .where({ videoId: videoId, userId: userId })
            .limit(1)
            .get();

        if (existing.length > 0 && existing[0].type === 'video') {
            return { success: true, message: '已举报，请勿重复提交' };
        }

        await db.collection(COLLECTIONS.REPORTS).add({
            reportId: generateUUID(),
            type: 'video',
            videoId: videoId,
            userId: userId,
            reason: reason,
            reasonText: reasonText || '',
            detail: detail || '',
            priority: priority || 1,
            status: 'pending',
            createdAt: new Date()
        });

        let emailResult = null;
        try {
            emailResult = await sendReportNotification({ videoId, userId, reason, reasonText, detail, priority });
        } catch (mailErr) {
            emailResult = { sent: false, error: mailErr.message };
        }

        return { success: true, message: '举报已提交', _debug_email: emailResult };
    } catch (e) {
        console.error('reportVideo error:', e);
        return { success: false, error: e.message || '举报失败' };
    }
}

// ============================================================
// 内容认领
// ============================================================

async function claimVideo({ videoId, userId, claimType, contactInfo, platformLink, detail }) {
    if (!videoId || !userId || !claimType || !contactInfo) {
        return { success: false, error: '缺少必要参数' };
    }

    try {
        const { data: existing } = await db.collection(COLLECTIONS.CLAIMS)
            .where({ videoId, userId })
            .limit(1)
            .get();

        if (existing.length > 0) {
            return { success: true, message: '您已提交过认领申请，请耐心等待处理' };
        }

        await db.collection(COLLECTIONS.CLAIMS).add({
            claimId: generateUUID(),
            videoId,
            userId,
            claimType,
            contactInfo,
            platformLink: platformLink || '',
            detail: detail || '',
            status: 'pending',
            createdAt: new Date()
        });

        let emailResult = null;
        try {
            emailResult = await sendClaimNotification({ videoId, userId, claimType, contactInfo, platformLink, detail });
        } catch (mailErr) {
            emailResult = { sent: false, error: mailErr.message };
        }

        return { success: true, message: '认领申请已提交', _debug_email: emailResult };
    } catch (e) {
        console.error('claimVideo error:', e);
        return { success: false, error: e.message || '认领失败' };
    }
}

async function sendClaimNotification({ videoId, userId, claimType, contactInfo, platformLink, detail }) {
    const claimTypeMap = {
        'creator': '视频创作者',
        'copyright_owner': '版权方',
        'coach_self': '教练本人'
    };

    const user = await getUserInfo(userId);
    const nickname = user?.nickname || user?.username || '未知';
    const phone = user?.phone || '未绑定';

    const time = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
    const subject = `[挥杯App] 内容认领申请 - ${claimTypeMap[claimType] || claimType}`;
    const html = `
        <div style="font-family: -apple-system, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
            <h2 style="color: #3b82f6; border-bottom: 2px solid #3b82f6; padding-bottom: 10px;">新内容认领申请</h2>
            <table style="width: 100%; border-collapse: collapse; margin-top: 15px;">
                <tr><td style="padding: 8px; font-weight: bold; color: #555; width: 100px;">认领身份</td><td style="padding: 8px; color: #3b82f6; font-weight: bold;">${claimTypeMap[claimType] || claimType}</td></tr>
                <tr style="background: #f9f9f9;"><td style="padding: 8px; font-weight: bold; color: #555;">联系方式</td><td style="padding: 8px; font-weight: bold; color: #e67e22;">${contactInfo}</td></tr>
                <tr><td style="padding: 8px; font-weight: bold; color: #555;">平台链接</td><td style="padding: 8px;">${platformLink || '-'}</td></tr>
                <tr style="background: #f9f9f9;"><td style="padding: 8px; font-weight: bold; color: #555;">补充说明</td><td style="padding: 8px;">${detail || '-'}</td></tr>
                <tr><td style="padding: 8px; font-weight: bold; color: #555;">视频ID</td><td style="padding: 8px; font-size: 12px;">${videoId}</td></tr>
            </table>
            <h3 style="color: #333; margin-top: 20px; border-bottom: 1px solid #ddd; padding-bottom: 8px;">申请用户信息</h3>
            <table style="width: 100%; border-collapse: collapse;">
                <tr><td style="padding: 8px; font-weight: bold; color: #555; width: 100px;">昵称</td><td style="padding: 8px;">${nickname}</td></tr>
                <tr style="background: #f9f9f9;"><td style="padding: 8px; font-weight: bold; color: #555;">手机号</td><td style="padding: 8px;">${phone}</td></tr>
                <tr><td style="padding: 8px; font-weight: bold; color: #555;">用户ID</td><td style="padding: 8px; font-size: 12px;">${userId}</td></tr>
            </table>
            <p style="color: #999; font-size: 12px; margin-top: 20px;">此邮件由挥杯App系统自动发送 · ${time}</p>
        </div>
    `;
    return await sendAdminNotification(subject, html);
}

// ============================================================
// 分类
// ============================================================

async function getCategories() {
    const { data: categories } = await db.collection(COLLECTIONS.CATEGORIES)
        .orderBy('sortOrder', 'asc')
        .get();

    return { success: true, categories };
}

async function getCoaches() {
    const { data: coaches } = await db.collection(COLLECTIONS.COACHES)
        .field({
            id: true,
            name: true,
            douyinId: true,
            tier: true,
            avatarURL: true,
            badges: true,
            externalLinks: true,
            autoFillEnabled: true,
        })
        .limit(200)
        .get();

    return { success: true, coaches };
}

// ============================================================
// 自动抓取脚本配置（单文档 plaza_auto_fill / config）
// ============================================================

function clampAutoFillConfig(raw) {
    const h = Number(raw && raw.publishIntervalHours);
    const v = Number(raw && raw.videosPerRound);
    return {
        publishIntervalHours: Math.min(168, Math.max(1, Number.isFinite(h) ? h : AUTO_FILL_DEFAULTS.publishIntervalHours)),
        videosPerRound: Math.min(20, Math.max(1, Number.isFinite(v) ? v : AUTO_FILL_DEFAULTS.videosPerRound)),
    };
}

async function getAutoFillConfig() {
    try {
        const { data } = await db.collection(COLLECTIONS.AUTO_FILL).doc(AUTO_FILL_DOC_ID).get();
        const doc = Array.isArray(data) && data.length ? data[0] : null;
        const merged = { ...AUTO_FILL_DEFAULTS, ...(doc || {}) };
        return { success: true, config: clampAutoFillConfig(merged) };
    } catch (e) {
        console.warn('[VideoPlaza] getAutoFillConfig fallback:', e.message);
        return { success: true, config: clampAutoFillConfig(AUTO_FILL_DEFAULTS) };
    }
}

async function setAutoFillConfig(params) {
    const { publishIntervalHours, videosPerRound } = params;
    if (publishIntervalHours === undefined && videosPerRound === undefined) {
        return { success: false, error: '请提供 publishIntervalHours 或 videosPerRound' };
    }

    let existing = {};
    try {
        const { data } = await db.collection(COLLECTIONS.AUTO_FILL).doc(AUTO_FILL_DOC_ID).get();
        if (Array.isArray(data) && data.length) {
            existing = data[0];
        }
    } catch (e) {
        /* empty */
    }

    const next = clampAutoFillConfig({ ...AUTO_FILL_DEFAULTS, ...existing });
    if (publishIntervalHours !== undefined) {
        const h = parseInt(publishIntervalHours, 10);
        if (Number.isFinite(h)) {
            next.publishIntervalHours = Math.min(168, Math.max(1, h));
        }
    }
    if (videosPerRound !== undefined) {
        const v = parseInt(videosPerRound, 10);
        if (Number.isFinite(v)) {
            next.videosPerRound = Math.min(20, Math.max(1, v));
        }
    }

    await db.collection(COLLECTIONS.AUTO_FILL).doc(AUTO_FILL_DOC_ID).set({
        ...next,
        updatedAt: new Date(),
    });

    return { success: true, config: next };
}

// ============================================================
// 播放计数
// ============================================================

async function incrementViewCount({ videoId }) {
    await db.collection(COLLECTIONS.VIDEOS)
        .where({ videoId })
        .update({ 'stats.views': _.inc(1) });

    return { success: true };
}

// ============================================================
// 管理接口：添加视频（你手动调用）
// ============================================================

async function addVideo(videoData) {
    if (!videoData.videoId) {
        videoData.videoId = generateUUID();
    }

    const requiredFields = ['title', 'vodURL'];
    for (const field of requiredFields) {
        if (!videoData[field]) {
            return { success: false, error: `缺少必填字段: ${field}` };
        }
    }

    if (videoData.sourceAwemeId) {
        const { data: dup } = await db.collection(COLLECTIONS.VIDEOS)
            .where({ sourceAwemeId: videoData.sourceAwemeId }).limit(1).get();
        if (dup.length > 0) {
            const d = dup[0];
            return { success: false, error: `抖音视频已存在：「${d.title}」(${d.deleted ? '已删除' : '在线'})，请勿重复添加` };
        }
    }

    if (videoData.vodFileId) {
        const { data: dup } = await db.collection(COLLECTIONS.VIDEOS)
            .where({ vodFileId: videoData.vodFileId }).limit(1).get();
        if (dup.length > 0) {
            const d = dup[0];
            return { success: false, error: `VOD FileID 已存在：「${d.title}」(${d.deleted ? '已删除' : '在线'})，请勿重复添加` };
        }
    }

    const { data: urlDup } = await db.collection(COLLECTIONS.VIDEOS)
        .where({ vodURL: videoData.vodURL }).limit(1).get();
    if (urlDup.length > 0) {
        const d = urlDup[0];
        return { success: false, error: `播放地址已存在：「${d.title}」(${d.deleted ? '已删除' : '在线'})，请勿重复添加` };
    }

    let sourceType = videoData.sourceType || 'curated';
    if (sourceType === 'curated' && !videoData.categoryId) {
        return { success: false, error: '精选教练视频必须选择分类' };
    }
    if ((sourceType === 'official' || sourceType === 'curated') && !videoData.coachId) {
        return { success: false, error: '官方合作和精选视频必须关联教练' };
    }

    let parentCategoryId = '';
    if (videoData.categoryId) {
        const { data: catCheck } = await db.collection(COLLECTIONS.CATEGORIES)
            .where({ id: videoData.categoryId }).limit(1).get();
        if (catCheck.length === 0) {
            return { success: false, error: `分类 "${videoData.categoryId}" 不存在，请从分类管理中选择` };
        }
        const cat = catCheck[0];
        parentCategoryId = cat.parentId || '';
        if (parentCategoryId === '') {
            return { success: false, error: '请选择二级分类，不能直接使用一级分类' };
        }
    }

    let coachTier = null;
    if (videoData.coachId) {
        const { data: coachCheck } = await db.collection(COLLECTIONS.COACHES)
            .where({ id: videoData.coachId }).limit(1).get();
        if (coachCheck.length === 0) {
            return { success: false, error: `教练 "${videoData.coachId}" 不存在，请从教练管理中选择` };
        }
        coachTier = coachCheck[0].tier || 'curated';
    }

    if (coachTier === 'official_partner') {
        sourceType = 'official';
    } else if (coachTier === 'pending') {
        sourceType = 'discovered';
    } else if (sourceType === 'official' && coachTier !== 'official_partner') {
        return { success: false, error: '只有官方合作教练的视频才能设为"官方"来源' };
    }

    const BASE_WEIGHTS = { official: 100, curated: 50, discovered: 10 };
    const coachId = videoData.coachId || '';
    const coachName = coachId ? await lookupCoachName(coachId) : '';

    const RESERVED_TAGS = ['官方合作', '官方', '精选', '精选教练', '官方合作教练'];
    const cleanTags = (videoData.tags || []).filter(t => !RESERVED_TAGS.includes(t));

    const video = {
        videoId: videoData.videoId,
        title: videoData.title,
        description: videoData.description || '',
        categoryId: videoData.categoryId || '',
        parentCategoryId,
        coachId,
        tags: cleanTags,
        coverURL: videoData.coverURL || '',
        vodURL: videoData.vodURL,
        vodFileId: videoData.vodFileId || '',
        sourceAwemeId: videoData.sourceAwemeId || '',
        duration: videoData.duration || 0,
        resolution: videoData.resolution || '1080p',
        publishTime: new Date(),
        isAuthorized: true,
        sourceType,
        sourceURL: videoData.sourceURL || '',
        addedBy: videoData.addedBy || 'manual',
        addedAt: new Date(),
        classificationHit: videoData.classificationHit || 'manual',
        baseWeight: BASE_WEIGHTS[sourceType] || 10,
        stats: {
            likes: 0,
            favorites: 0,
            comments: 0,
            views: 0,
            score: 0
        },
        searchText: buildSearchText(videoData, coachName)
    };

    await db.collection(COLLECTIONS.VIDEOS).add(video);
    return { success: true, video };
}

async function addCoach(coachData) {
    const tier = coachData.tier || 'curated';
    const badges = coachData.badges || [];
    if (tier === 'official_partner' && !badges.includes('official')) {
        badges.push('official');
    } else if (tier !== 'official_partner') {
        const idx = badges.indexOf('official');
        if (idx !== -1) badges.splice(idx, 1);
    }

    const coach = {
        id: coachData.id,
        name: coachData.name,
        avatarURL: coachData.avatarURL || '',
        certification: coachData.certification || '',
        bio: coachData.bio || '',
        externalLinks: coachData.externalLinks || [],
        bannerURL: coachData.bannerURL || '',
        badges,
        region: coachData.region || '',
        tier,
        douyinId: coachData.douyinId || '',
        secUid: coachData.secUid || '',
        autoFillEnabled: coachData.autoFillEnabled === false ? false : true,
    };

    await db.collection(COLLECTIONS.COACHES).add(coach);
    return { success: true, coach };
}

// ============================================================
// 根据分类获取教练列表
// ============================================================

async function getCoachesByCategory({ categoryId }) {
    if (!categoryId) {
        return { success: false, error: '缺少 categoryId' };
    }

    const { data: videos } = await db.collection(COLLECTIONS.VIDEOS)
        .where({ categoryId, isAuthorized: true })
        .field({ coachId: true })
        .limit(200)
        .get();

    const coachIds = [...new Set(videos.map(v => v.coachId).filter(Boolean))];

    if (coachIds.length === 0) {
        return { success: true, coaches: [] };
    }

    const { data: coaches } = await db.collection(COLLECTIONS.COACHES)
        .where({ id: _.in(coachIds) })
        .field({ id: true, name: true, avatarURL: true, tier: true })
        .get();

    return { success: true, coaches };
}

// ============================================================
// 工具函数
// ============================================================

// ============================================================
// 搜索索引
// ============================================================

function buildSearchText(videoData, coachName) {
    const parts = [
        videoData.title || '',
        videoData.description || '',
        ...(videoData.tags || []),
        coachName || ''
    ];
    return parts.filter(Boolean).join(' ').toLowerCase();
}

async function lookupCoachName(coachId) {
    if (!coachId) return '';
    try {
        let { data } = await db.collection(COLLECTIONS.COACHES)
            .where({ id: coachId })
            .limit(1)
            .get();
        if (data.length === 0) {
            const result = await db.collection(COLLECTIONS.COACHES)
                .where({ id: db.RegExp({ regexp: `^${escapeRegExp(coachId)}$`, options: 'i' }) })
                .limit(1)
                .get();
            data = result.data;
        }
        return data.length > 0 ? (data[0].name || '') : '';
    } catch {
        return '';
    }
}

function escapeRegExp(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function uploadCoachImage({ coachId, imageBase64, imageType, fileExt = 'jpg' }) {
    if (!coachId || !imageBase64 || !imageType) {
        return { success: false, error: '缺少必要参数: coachId, imageBase64, imageType' };
    }
    if (!['avatar', 'banner'].includes(imageType)) {
        return { success: false, error: 'imageType 必须为 avatar 或 banner' };
    }

    const imageBuffer = Buffer.from(imageBase64, 'base64');

    const maxSize = imageType === 'avatar' ? 2 * 1024 * 1024 : 5 * 1024 * 1024;
    if (imageBuffer.length > maxSize) {
        const limitMB = imageType === 'avatar' ? '2MB' : '5MB';
        return { success: false, error: `图片大小不能超过 ${limitMB}` };
    }

    const timestamp = Date.now();
    const cloudPath = `coaches/${coachId}/${imageType}_${timestamp}.${fileExt}`;

    const uploadResult = await app.uploadFile({
        cloudPath: cloudPath,
        fileContent: imageBuffer
    });

    if (!uploadResult.fileID) {
        return { success: false, error: '上传失败，未获取到 fileID' };
    }

    let imageUrl = '';
    try {
        const urlResult = await app.getTempFileURL({ fileList: [uploadResult.fileID] });
        if (urlResult.fileList && urlResult.fileList.length > 0 && urlResult.fileList[0].tempFileURL) {
            imageUrl = urlResult.fileList[0].tempFileURL;
        }
    } catch (e) {
        console.warn('getTempFileURL failed, using fallback URL:', e.message);
    }

    if (!imageUrl) {
        const envId = process.env.TCB_ENV || 'mygolfswingapp-9g2izywqa8ac3f5b';
        imageUrl = `https://6d79-${envId}-1259543736.tcb.qcloud.la/${cloudPath}`;
    }

    const updateField = imageType === 'avatar' ? 'avatarURL' : 'bannerURL';
    await db.collection(COLLECTIONS.COACHES)
        .where({ id: coachId })
        .update({ [updateField]: imageUrl });

    return {
        success: true,
        imageUrl,
        fileID: uploadResult.fileID,
        field: updateField
    };
}

async function rebuildSearchIndex() {
    const { data: allVids } = await db.collection(COLLECTIONS.VIDEOS)
        .limit(1000)
        .get();

    const { data: coaches } = await db.collection(COLLECTIONS.COACHES)
        .limit(100)
        .get();

    const coachMap = {};
    coaches.forEach(c => { coachMap[c.id] = c.name || ''; });

    let updated = 0;
    for (const video of allVids) {
        const coachName = coachMap[video.coachId] || '';
        const searchText = buildSearchText(video, coachName);
        await db.collection(COLLECTIONS.VIDEOS)
            .where({ videoId: video.videoId })
            .update({ searchText });
        updated++;
    }

    return { success: true, message: `已重建 ${updated} 条视频的搜索索引` };
}

// ============================================================
// 工具函数
// ============================================================

// finalScore = baseWeight + engagement(likes*1 + favorites*3 + comments*2)
async function updateScore(videoId) {
    const { data } = await db.collection(COLLECTIONS.VIDEOS)
        .where({ videoId })
        .limit(1)
        .get();

    if (data.length > 0) {
        const stats = data[0].stats || {};
        const baseWeight = data[0].baseWeight || 10;
        const engagement = (stats.likes || 0) * 1 + (stats.favorites || 0) * 3 + (stats.comments || 0) * 2;
        const score = baseWeight + engagement;
        await db.collection(COLLECTIONS.VIDEOS)
            .where({ videoId })
            .update({ 'stats.score': score });
    }
}

async function sendAdminNotification(subject, htmlContent) {
    try {
        const info = await mailTransporter.sendMail({
            from: `"挥杯App通知" <${process.env.MAIL_USER || ADMIN_EMAIL}>`,
            to: ADMIN_EMAIL,
            subject: subject,
            html: htmlContent
        });
        console.log('邮件通知已发送:', subject, 'messageId:', info.messageId);
        return { sent: true, messageId: info.messageId };
    } catch (e) {
        console.error('邮件发送失败:', e.message, e.code, e.responseCode);
        return { sent: false, error: e.message, code: e.code, responseCode: e.responseCode };
    }
}

async function getUserInfo(userId) {
    try {
        const methods = [
            () => db.collection('users').doc(userId).get(),
            () => db.collection('users').where({ objectId: userId }).get(),
            () => db.collection('users').where({ imUserId: userId }).get(),
            () => db.collection('users').where({ username: userId }).get()
        ];
        for (const method of methods) {
            try {
                const result = await method();
                const data = result.data;
                const user = Array.isArray(data) ? data[0] : data;
                if (user) return user;
            } catch (e) { /* try next */ }
        }
    } catch (e) {
        console.error('getUserInfo error:', e.message);
    }
    return null;
}

async function sendReportNotification({ videoId, userId, reason, reasonText, detail, priority }) {
    const reasonMap = {
        'copyright': '侵权/虚假信息',
        'pornography': '色情低俗',
        'violence': '暴力恐怖',
        'harassment': '骚扰辱骂',
        'childAbuse': '危害未成年人',
        'spam': '垃圾广告',
        'other': '其他'
    };

    const user = await getUserInfo(userId);
    const nickname = user?.nickname || user?.username || '未知';
    const gender = user?.gender === 'male' ? '男' : user?.gender === 'female' ? '女' : (user?.gender || '未设置');
    const phone = user?.phone || '未绑定';
    const age = user?.birthday ? Math.floor((Date.now() - new Date(user.birthday).getTime()) / (365.25 * 24 * 60 * 60 * 1000)) + '岁' : (user?.age ? user.age + '岁' : '未设置');

    const time = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
    const subject = `[挥杯App] 视频举报 - ${reasonMap[reason] || reason}`;
    const html = `
        <div style="font-family: -apple-system, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
            <h2 style="color: #e74c3c; border-bottom: 2px solid #e74c3c; padding-bottom: 10px;">新视频举报通知</h2>
            <table style="width: 100%; border-collapse: collapse; margin-top: 15px;">
                <tr><td style="padding: 8px; font-weight: bold; color: #555; width: 100px;">举报原因</td><td style="padding: 8px; color: #e74c3c; font-weight: bold;">${reasonMap[reason] || reason}</td></tr>
                <tr style="background: #f9f9f9;"><td style="padding: 8px; font-weight: bold; color: #555;">原因说明</td><td style="padding: 8px;">${reasonText || '-'}</td></tr>
                <tr><td style="padding: 8px; font-weight: bold; color: #555;">补充详情</td><td style="padding: 8px;">${detail || '-'}</td></tr>
                <tr style="background: #f9f9f9;"><td style="padding: 8px; font-weight: bold; color: #555;">视频ID</td><td style="padding: 8px; font-size: 12px;">${videoId}</td></tr>
                <tr><td style="padding: 8px; font-weight: bold; color: #555;">优先级</td><td style="padding: 8px;">${priority || 1}</td></tr>
            </table>
            <h3 style="color: #333; margin-top: 20px; border-bottom: 1px solid #ddd; padding-bottom: 8px;">举报用户信息</h3>
            <table style="width: 100%; border-collapse: collapse;">
                <tr><td style="padding: 8px; font-weight: bold; color: #555; width: 100px;">昵称</td><td style="padding: 8px;">${nickname}</td></tr>
                <tr style="background: #f9f9f9;"><td style="padding: 8px; font-weight: bold; color: #555;">性别</td><td style="padding: 8px;">${gender}</td></tr>
                <tr><td style="padding: 8px; font-weight: bold; color: #555;">年龄</td><td style="padding: 8px;">${age}</td></tr>
                <tr style="background: #f9f9f9;"><td style="padding: 8px; font-weight: bold; color: #555;">手机号</td><td style="padding: 8px;">${phone}</td></tr>
                <tr><td style="padding: 8px; font-weight: bold; color: #555;">用户ID</td><td style="padding: 8px; font-size: 12px;">${userId}</td></tr>
            </table>
            <p style="color: #999; font-size: 12px; margin-top: 20px;">此邮件由挥杯App系统自动发送 · ${time}</p>
        </div>
    `;
    return await sendAdminNotification(subject, html);
}

function generateUUID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

// ============================================================
// 管理后台：权限验证
// ============================================================

function adminAuth({ adminKey }) {
    if (!ADMIN_KEY) {
        return { success: false, error: '未配置 PLAZA_ADMIN_KEY / ADMIN_KEY 环境变量' };
    }
    if (adminKey === ADMIN_KEY) {
        return { success: true, message: '验证通过' };
    }
    return { success: false, error: '管理密码错误' };
}

async function requireAdmin(params, fn) {
    if (!ADMIN_KEY) {
        return { success: false, error: '未配置 PLAZA_ADMIN_KEY / ADMIN_KEY 环境变量' };
    }
    if (params.adminKey !== ADMIN_KEY) {
        return { success: false, error: '未授权：管理密码错误' };
    }
    const { adminKey, ...rest } = params;
    return await fn(rest);
}

// ============================================================
// 管理后台：视频 CRUD
// ============================================================

async function adminListVideos({ limit = 100, offset = 0 }) {
    const { data: videos } = await db.collection(COLLECTIONS.VIDEOS)
        .where({ deleted: _.neq(true) })
        .orderBy('publishTime', 'desc')
        .skip(offset)
        .limit(limit)
        .get();

    const { total } = await db.collection(COLLECTIONS.VIDEOS).where({ deleted: _.neq(true) }).count();

    return { success: true, videos, total };
}

async function updateVideo(params) {
    const { videoId, ...updates } = params;
    if (!videoId) {
        return { success: false, error: '缺少 videoId' };
    }

    const allowedFields = [
        'title', 'description', 'categoryId', 'coachId',
        'tags', 'coverURL', 'vodURL', 'vodFileId', 'duration',
        'resolution', 'isAuthorized', 'publishTime',
        'sourceType', 'sourceURL', 'baseWeight'
    ];
    const updateData = {};
    for (const field of allowedFields) {
        if (updates[field] !== undefined) {
            updateData[field] = updates[field];
        }
    }

    if (updateData.tags) {
        const RESERVED_TAGS = ['官方合作', '官方', '精选', '精选教练', '官方合作教练'];
        updateData.tags = updateData.tags.filter(t => !RESERVED_TAGS.includes(t));
    }

    if (Object.keys(updateData).length === 0) {
        return { success: false, error: '没有可更新的字段' };
    }

    if (updateData.categoryId) {
        const { data: catCheck } = await db.collection(COLLECTIONS.CATEGORIES)
            .where({ id: updateData.categoryId }).limit(1).get();
        if (catCheck.length === 0) {
            return { success: false, error: `分类 "${updateData.categoryId}" 不存在，请从分类管理中选择` };
        }
        const cat = catCheck[0];
        if (!cat.parentId || cat.parentId === '') {
            return { success: false, error: '请选择二级分类，不能直接使用一级分类' };
        }
        updateData.parentCategoryId = cat.parentId;
    } else if (updateData.categoryId === '') {
        updateData.parentCategoryId = '';
    }

    if (updateData.coachId) {
        const { data: coachCheck } = await db.collection(COLLECTIONS.COACHES)
            .where({ id: updateData.coachId }).limit(1).get();
        if (coachCheck.length === 0) {
            return { success: false, error: `教练 "${updateData.coachId}" 不存在，请从教练管理中选择` };
        }
    }

    const searchAffectingFields = ['title', 'description', 'tags', 'coachId'];
    if (searchAffectingFields.some(f => updateData[f] !== undefined)) {
        const { data: currentVideo } = await db.collection(COLLECTIONS.VIDEOS)
            .where({ videoId })
            .limit(1)
            .get();

        if (currentVideo.length > 0) {
            const merged = { ...currentVideo[0], ...updateData };
            const coachName = await lookupCoachName(merged.coachId);
            updateData.searchText = buildSearchText(merged, coachName);
        }
    }

    const { updated } = await db.collection(COLLECTIONS.VIDEOS)
        .where({ videoId })
        .update(updateData);

    return { success: true, updated };
}

async function deleteVideo({ videoId }) {
    if (!videoId) {
        return { success: false, error: '缺少 videoId' };
    }

    await db.collection(COLLECTIONS.VIDEOS).where({ videoId })
        .update({ deleted: true, deletedAt: new Date() });
    await db.collection(COLLECTIONS.LIKES).where({ videoId }).remove();
    await db.collection(COLLECTIONS.FAVORITES).where({ videoId }).remove();
    await db.collection(COLLECTIONS.COMMENTS).where({ videoId }).remove();

    return { success: true, message: '视频已标记删除，元数据已保留用于去重' };
}

// ============================================================
// 管理后台：教练 CRUD
// ============================================================

async function adminListCoaches({ limit = 100, offset = 0 }) {
    const { data: coaches } = await db.collection(COLLECTIONS.COACHES)
        .skip(offset)
        .limit(limit)
        .get();

    return { success: true, coaches };
}

async function updateCoach(params) {
    const { coachId, ...updates } = params;
    if (!coachId) {
        return { success: false, error: '缺少 coachId' };
    }

    const allowedFields = ['name', 'avatarURL', 'certification', 'bio', 'externalLinks', 'bannerURL', 'badges', 'region', 'tier', 'douyinId', 'secUid', 'autoFillEnabled'];
    const updateData = {};
    for (const field of allowedFields) {
        if (updates[field] !== undefined) {
            updateData[field] = updates[field];
        }
    }

    if (updateData.tier !== undefined) {
        const badges = updateData.badges || updates.badges || [];
        if (updateData.tier === 'official_partner' && !badges.includes('official')) {
            badges.push('official');
        } else if (updateData.tier !== 'official_partner') {
            const idx = badges.indexOf('official');
            if (idx !== -1) badges.splice(idx, 1);
        }
        updateData.badges = badges;
    }

    if (Object.keys(updateData).length === 0) {
        return { success: false, error: '没有可更新的字段' };
    }

    const { updated } = await db.collection(COLLECTIONS.COACHES)
        .where({ id: coachId })
        .update(updateData);

    return { success: true, updated };
}

async function deleteCoach({ coachId }) {
    if (!coachId) {
        return { success: false, error: '缺少 coachId' };
    }

    const { data: linkedVideos } = await db.collection(COLLECTIONS.VIDEOS)
        .where({ coachId }).limit(500).get();
    for (const video of linkedVideos) {
        await db.collection(COLLECTIONS.VIDEOS)
            .where({ videoId: video.videoId })
            .update({ coachId: '', sourceType: 'discovered', baseWeight: 10 });
    }

    await db.collection(COLLECTIONS.COACHES).where({ id: coachId }).remove();
    return { success: true, message: `教练已删除，${linkedVideos.length} 个关联视频已解除绑定` };
}

// ============================================================
// 管理后台：分类 CRUD
// ============================================================

async function addCategory({ id, name, icon, sortOrder, parentId, description }) {
    if (!id || !name) {
        return { success: false, error: '缺少 id 或 name' };
    }

    if (parentId) {
        const { data: parentCheck } = await db.collection(COLLECTIONS.CATEGORIES)
            .where({ id: parentId }).limit(1).get();
        if (parentCheck.length === 0) {
            return { success: false, error: `父分类 "${parentId}" 不存在` };
        }
        if (parentCheck[0].parentId && parentCheck[0].parentId !== '') {
            return { success: false, error: `"${parentId}" 是二级分类，不能在其下创建子分类` };
        }
    }

    const category = {
        id,
        name,
        icon: icon || 'figure.golf',
        sortOrder: sortOrder || 99,
        parentId: parentId || '',
        description: description || ''
    };

    await db.collection(COLLECTIONS.CATEGORIES).add(category);
    return { success: true, category };
}

async function updateCategory(params) {
    const { categoryId, ...updates } = params;
    if (!categoryId) {
        return { success: false, error: '缺少 categoryId' };
    }

    const allowedFields = ['name', 'icon', 'sortOrder', 'parentId', 'description'];
    const updateData = {};
    for (const field of allowedFields) {
        if (updates[field] !== undefined) {
            updateData[field] = updates[field];
        }
    }

    const { updated } = await db.collection(COLLECTIONS.CATEGORIES)
        .where({ id: categoryId })
        .update(updateData);

    return { success: true, updated };
}

async function deleteCategory({ categoryId }) {
    if (!categoryId) {
        return { success: false, error: '缺少 categoryId' };
    }

    const { data: catData } = await db.collection(COLLECTIONS.CATEGORIES)
        .where({ id: categoryId }).limit(1).get();
    const isTopLevel = catData.length > 0 && (!catData[0].parentId || catData[0].parentId === '');

    if (isTopLevel) {
        const { data: children } = await db.collection(COLLECTIONS.CATEGORIES)
            .where({ parentId: categoryId }).limit(500).get();
        for (const child of children) {
            const { data: childVideos } = await db.collection(COLLECTIONS.VIDEOS)
                .where({ categoryId: child.id }).limit(500).get();
            for (const video of childVideos) {
                await db.collection(COLLECTIONS.VIDEOS)
                    .where({ videoId: video.videoId })
                    .update({ categoryId: '', parentCategoryId: '' });
            }
        }
        await db.collection(COLLECTIONS.CATEGORIES).where({ parentId: categoryId }).remove();

        const { data: directVideos } = await db.collection(COLLECTIONS.VIDEOS)
            .where({ parentCategoryId: categoryId }).limit(500).get();
        for (const video of directVideos) {
            await db.collection(COLLECTIONS.VIDEOS)
                .where({ videoId: video.videoId })
                .update({ categoryId: '', parentCategoryId: '' });
        }
    } else {
        const { data: linkedVideos } = await db.collection(COLLECTIONS.VIDEOS)
            .where({ categoryId }).limit(500).get();
        for (const video of linkedVideos) {
            await db.collection(COLLECTIONS.VIDEOS)
                .where({ videoId: video.videoId })
                .update({ categoryId: '', parentCategoryId: '' });
        }
    }

    await db.collection(COLLECTIONS.CATEGORIES).where({ id: categoryId }).remove();
    return { success: true, message: '分类已删除，关联视频的分类已清空' };
}

// ============================================================
// VOD 元数据查询（通过腾讯云 VOD DescribeMediaInfos API）
// ============================================================

async function getVodMediaInfo({ fileId }) {
    if (!fileId) {
        return { success: false, error: '缺少 fileId' };
    }
    if (!VOD_SECRET_ID || !VOD_SECRET_KEY) {
        return { success: false, error: '未配置 VOD_SECRET_ID / VOD_SECRET_KEY 环境变量，请在 CloudBase 控制台 -> 云函数 -> 环境变量中设置' };
    }

    const action = 'DescribeMediaInfos';
    const version = '2018-07-17';
    const service = 'vod';
    const host = 'vod.tencentcloudapi.com';
    const timestamp = Math.floor(Date.now() / 1000);
    const date = new Date(timestamp * 1000).toISOString().slice(0, 10);

    const payload = JSON.stringify({
        FileIds: [fileId],
        Filters: ['basicInfo', 'metaData', 'transcodeInfo']
    });

    // TC3-HMAC-SHA256 签名
    const hashedPayload = crypto.createHash('sha256').update(payload).digest('hex');
    const canonicalHeaders = `content-type:application/json; charset=utf-8\nhost:${host}\nx-tc-action:${action.toLowerCase()}\n`;
    const signedHeaders = 'content-type;host;x-tc-action';
    const canonicalRequest = `POST\n/\n\n${canonicalHeaders}\n${signedHeaders}\n${hashedPayload}`;

    const algorithm = 'TC3-HMAC-SHA256';
    const credentialScope = `${date}/${service}/tc3_request`;
    const hashedCanonicalRequest = crypto.createHash('sha256').update(canonicalRequest).digest('hex');
    const stringToSign = `${algorithm}\n${timestamp}\n${credentialScope}\n${hashedCanonicalRequest}`;

    function hmacSha256(key, data) {
        return crypto.createHmac('sha256', key).update(data).digest();
    }

    const secretDate = hmacSha256(Buffer.from('TC3' + VOD_SECRET_KEY), date);
    const secretService = hmacSha256(secretDate, service);
    const secretSigning = hmacSha256(secretService, 'tc3_request');
    const signature = crypto.createHmac('sha256', secretSigning).update(stringToSign).digest('hex');

    const authorization = `${algorithm} Credential=${VOD_SECRET_ID}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

    return new Promise((resolve) => {
        const options = {
            hostname: host,
            path: '/',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json; charset=utf-8',
                'Host': host,
                'X-TC-Action': action,
                'X-TC-Version': version,
                'X-TC-Timestamp': timestamp.toString(),
                'Authorization': authorization
            }
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                try {
                    const result = JSON.parse(data);
                    if (result.Response && result.Response.Error) {
                        resolve({ success: false, error: result.Response.Error.Message });
                        return;
                    }

                    const mediaInfoSet = result.Response?.MediaInfoSet || [];
                    if (mediaInfoSet.length === 0) {
                        resolve({ success: false, error: '未找到该 FileID 对应的视频' });
                        return;
                    }

                    const info = mediaInfoSet[0];
                    const basicInfo = info.BasicInfo || {};
                    const metaData = info.MetaData || {};
                    const transcodeInfo = info.TranscodeInfo || {};

                    // 优先使用转码后的高清地址
                    let vodURL = basicInfo.MediaUrl || '';
                    const transcodeSet = transcodeInfo.TranscodeSet || [];
                    const hd = transcodeSet.find(t => t.Height >= 1080 || t.Width >= 1080);
                    if (hd && hd.Url) {
                        vodURL = hd.Url;
                    } else if (transcodeSet.length > 0 && transcodeSet[0].Url) {
                        vodURL = transcodeSet[0].Url;
                    }

                    const height = metaData.Height || 0;
                    let resolution = '720p';
                    if (height >= 2160) resolution = '4K';
                    else if (height >= 1080) resolution = '1080p';
                    else if (height >= 720) resolution = '720p';
                    else if (height > 0) resolution = `${height}p`;

                    resolve({
                        success: true,
                        mediaInfo: {
                            coverURL: basicInfo.CoverUrl || '',
                            vodURL,
                            duration: Math.round(metaData.Duration || 0),
                            width: metaData.Width || 0,
                            height: height,
                            resolution,
                            title: basicInfo.Name || '',
                            size: basicInfo.Size || 0
                        }
                    });
                } catch (e) {
                    resolve({ success: false, error: '解析 VOD 响应失败: ' + e.message });
                }
            });
        });

        req.on('error', (e) => {
            resolve({ success: false, error: 'VOD API 请求失败: ' + e.message });
        });

        req.write(payload);
        req.end();
    });
}

// ============================================================
// VOD API 请求工具函数
// ============================================================

async function vodRequest(action, params) {
    const version = '2018-07-17';
    const service = 'vod';
    const host = 'vod.tencentcloudapi.com';
    const timestamp = Math.floor(Date.now() / 1000);
    const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
    
    // ApplyUpload 接口参数格式
    const apiParams = {};
    if (action === 'ApplyUpload') {
        apiParams.MediaType = params.MediaType || 'mp4';
        if (params.MediaName) apiParams.MediaName = params.MediaName;
    } else if (action === 'DescribeMediaInfos') {
        apiParams.FileIds = params.FileIds || [];
    } else {
        Object.assign(apiParams, params);
    }
    
    const payload = JSON.stringify(apiParams);
    
    // 签名计算
    const crypto = require('crypto');
    const hmacSha256 = (key, msg) => crypto.createHmac('sha256', key).update(msg).digest();
    
    const canonicalRequest = `POST\n/\n\ncontent-type:application/json; charset=utf-8\nhost:${host}\n\ncontent-type;host\n${crypto.createHash('sha256').update(payload).digest('hex')}`;
    const credentialScope = `${date}/${service}/tc3_request`;
    const stringToSign = `TC3-HMAC-SHA256\n${timestamp}\n${credentialScope}\n${crypto.createHash('sha256').update(canonicalRequest).digest('hex')}`;
    
    const secretDate = hmacSha256(Buffer.from('TC3' + VOD_SECRET_KEY), date);
    const secretService = hmacSha256(secretDate, service);
    const secretSigning = hmacSha256(secretService, 'tc3_request');
    const signature = hmacSha256(secretSigning, stringToSign).toString('hex');
    
    const authorization = `TC3-HMAC-SHA256 Credential=${VOD_SECRET_ID}/${credentialScope}, SignedHeaders=content-type;host, Signature=${signature}`;
    
    return new Promise((resolve) => {
        const options = {
            hostname: host,
            port: 443,
            path: '/',
            method: 'POST',
            headers: {
                'Authorization': authorization,
                'Content-Type': 'application/json; charset=utf-8',
                'Host': host,
                'X-TC-Action': action,
                'X-TC-Timestamp': timestamp.toString(),
                'X-TC-Version': version,
                'X-TC-Region': VOD_REGION
            }
        };
        
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                try {
                    const result = JSON.parse(data);
                    // 返回 Response 里面的内容
                    if (result.Response) {
                        resolve({ success: true, ...result.Response });
                    } else if (result.Response && result.Response.Error) {
                        resolve({ success: false, error: result.Response.Error.Message });
                    } else {
                        resolve({ success: true, ...result });
                    }
                } catch (e) {
                    resolve({ success: false, error: '解析响应失败：' + e.message, raw: data });
                }
            });
        });
        
        req.on('error', (e) => {
            resolve({ success: false, error: 'VOD API 请求失败：' + e.message });
        });
        
        req.write(payload);
        req.end();
    });
}

// ============================================================
// Billing + source resolver helpers
// ============================================================

function hmacSha256(key, msg, encoding) {
    return crypto.createHmac('sha256', key).update(msg).digest(encoding);
}

async function tencentRequest({ service, host, version, region = '', action, params = {}, secretId = TENCENT_SECRET_ID, secretKey = TENCENT_SECRET_KEY }) {
    if (!secretId || !secretKey) {
        return { success: false, error: '未配置腾讯云密钥环境变量 TENCENT_SECRET_ID / TENCENT_SECRET_KEY（或 VOD_SECRET_ID / VOD_SECRET_KEY）', code: 'MISSING_SECRET' };
    }

    const timestamp = Math.floor(Date.now() / 1000);
    const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
    const payload = JSON.stringify(params || {});
    const hashedPayload = crypto.createHash('sha256').update(payload).digest('hex');
    const canonicalRequest = `POST\n/\n\ncontent-type:application/json; charset=utf-8\nhost:${host}\n\ncontent-type;host\n${hashedPayload}`;
    const credentialScope = `${date}/${service}/tc3_request`;
    const stringToSign = `TC3-HMAC-SHA256\n${timestamp}\n${credentialScope}\n${crypto.createHash('sha256').update(canonicalRequest).digest('hex')}`;
    const secretDate = hmacSha256(Buffer.from('TC3' + secretKey), date);
    const secretService = hmacSha256(secretDate, service);
    const secretSigning = hmacSha256(secretService, 'tc3_request');
    const signature = hmacSha256(secretSigning, stringToSign, 'hex');
    const authorization = `TC3-HMAC-SHA256 Credential=${secretId}/${credentialScope}, SignedHeaders=content-type;host, Signature=${signature}`;

    return new Promise((resolve) => {
        const headers = {
            Authorization: authorization,
            'Content-Type': 'application/json; charset=utf-8',
            Host: host,
            'X-TC-Action': action,
            'X-TC-Timestamp': timestamp.toString(),
            'X-TC-Version': version,
        };
        if (region) headers['X-TC-Region'] = region;

        const req = https.request({ hostname: host, port: 443, path: '/', method: 'POST', headers }, (res) => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    const response = json.Response || json;
                    if (response.Error) {
                        resolve({
                            success: false,
                            error: response.Error.Message || '腾讯云接口返回错误',
                            code: response.Error.Code,
                            requestId: response.RequestId,
                            raw: response,
                        });
                        return;
                    }
                    resolve({ success: true, ...response, raw: response });
                } catch (e) {
                    resolve({ success: false, error: '解析腾讯云响应失败: ' + e.message, raw: data });
                }
            });
        });
        req.on('error', e => resolve({ success: false, error: '腾讯云 API 请求失败: ' + e.message }));
        req.write(payload);
        req.end();
    });
}

function pad2(n) {
    return String(n).padStart(2, '0');
}

function currentMonth() {
    const d = new Date();
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
}

function monthDateRange(month) {
    const [year, monthNum] = month.split('-').map(Number);
    const start = new Date(Date.UTC(year, monthNum - 1, 1, 0, 0, 0));
    const end = new Date(Date.UTC(year, monthNum, 0, 23, 59, 59));
    return {
        month,
        beginMonth: month,
        endMonth: month,
        beginTime: start.toISOString().replace(/\.\d{3}Z$/, 'Z'),
        endTime: end.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    };
}

function numberFrom(value) {
    if (value == null || value === '') return null;
    const n = Number(String(value).replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
}

function moneyMetric(amount, raw) {
    return { amount: amount == null ? null : Number(amount), currency: 'CNY', raw };
}

function usageMetric(value, unit, raw) {
    return { value: value == null ? null : Number(value), unit: unit || '', raw };
}

function findFirstNumber(obj, keys) {
    if (!obj || typeof obj !== 'object') return null;
    for (const key of keys) {
        const n = numberFrom(obj[key]);
        if (n != null) return n;
    }
    return null;
}

function collectNumbers(obj, keys, out = []) {
    if (!obj || typeof obj !== 'object') return out;
    for (const [key, value] of Object.entries(obj)) {
        if (keys.includes(key)) {
            const n = numberFrom(value);
            if (n != null) out.push(n);
        }
        if (value && typeof value === 'object') collectNumbers(value, keys, out);
    }
    return out;
}

function billingItems(resp) {
    return resp?.Data || resp?.DetailSet || resp?.SummaryOverview || resp?.Items || resp?.List || [];
}

function parseBilling(resp) {
    const items = Array.isArray(billingItems(resp)) ? billingItems(resp) : [];
    let total = 0;
    let vodCost = 0;
    let vodRaw = null;
    for (const item of items) {
        const amount = findFirstNumber(item, ['RealTotalCost', 'RealCost', 'CashPayAmount', 'TotalCost', 'Cost']);
        if (amount != null) total += amount;
        const productName = String(item.BusinessCodeName || item.ProductName || item.ProductCodeName || item.Name || '');
        const productCode = String(item.BusinessCode || item.ProductCode || '');
        if (/云点播|视频点播|VOD|Video on Demand/i.test(productName + ' ' + productCode)) {
            if (amount != null) vodCost += amount;
            vodRaw = item;
        }
    }
    return { totalCost: total || findFirstNumber(resp, ['RealTotalCost', 'RealCost', 'TotalCost']), vodCost: vodCost || null, vodRaw, rawItems: items };
}

function parseBalance(resp) {
    const amount = findFirstNumber(resp, ['Balance', 'RealBalance', 'CashAccountBalance', 'CashBalance', 'CreditBalance']);
    return moneyMetric(amount, resp.raw || resp);
}

function parseStorage(resp) {
    const series = resp?.Data || resp?.StorageDataSet || resp?.StorageStatDataSet || [];
    const nums = collectNumbers(series, ['Storage', 'StorageAmount', 'Value']);
    const value = nums.length ? nums[nums.length - 1] : findFirstNumber(resp, ['TotalStorage', 'StandardStorage', 'Storage', 'StorageAmount', 'Value']);
    return usageMetric(value, 'byte', resp.raw || resp);
}

function parseCdn(resp) {
    const nums = collectNumbers(resp, ['Flux', 'Traffic', 'Value']);
    const value = nums.reduce((sum, n) => sum + n, 0) || findFirstNumber(resp, ['Flux', 'Traffic', 'Value']);
    return usageMetric(value, 'byte', resp.raw || resp);
}

async function getBillingDashboard({ month } = {}) {
    const range = monthDateRange(month || currentMonth());
    const warnings = [];

    if (!TENCENT_SECRET_ID || !TENCENT_SECRET_KEY) {
        return {
            success: true,
            dashboard: {
                month: range.month,
                balance: moneyMetric(null, null),
                totalCost: moneyMetric(null, null),
                vodCost: moneyMetric(null, null),
                storage: usageMetric(null, 'byte', null),
                cdnUsage: usageMetric(null, 'byte', null),
                updatedAt: new Date().toISOString(),
                warnings: ['未配置腾讯云密钥环境变量，无法读取账单和 VOD 用量'],
            },
        };
    }

    const [balanceResp, costResp, storageResp, cdnResp] = await Promise.all([
        tencentRequest({ service: 'billing', host: 'billing.tencentcloudapi.com', version: '2018-07-09', action: 'DescribeAccountBalance' }),
        tencentRequest({
            service: 'billing',
            host: 'billing.tencentcloudapi.com',
            version: '2018-07-09',
            action: 'DescribeCostSummaryByProduct',
            params: { BeginTime: range.beginMonth, EndTime: range.endMonth, NeedRecordNum: 1, Limit: 100, Offset: 0 },
        }),
        tencentRequest({
            service: 'vod',
            host: 'vod.tencentcloudapi.com',
            version: '2018-07-17',
            region: VOD_REGION,
            action: 'DescribeStorageData',
            params: {},
        }),
        tencentRequest({
            service: 'vod',
            host: 'vod.tencentcloudapi.com',
            version: '2018-07-17',
            region: VOD_REGION,
            action: 'DescribeCDNUsageData',
            params: { StartTime: range.beginTime, EndTime: range.endTime, DataType: 'Flux' },
        }),
    ]);

    for (const [label, resp] of [['账户余额', balanceResp], ['产品费用', costResp], ['VOD 存储', storageResp], ['VOD CDN 流量', cdnResp]]) {
        if (!resp.success) {
            const reason = resp.code ? `${resp.code}: ${resp.error}` : resp.error;
            warnings.push(`${label}读取失败：${reason}`);
        }
    }

    const cost = costResp.success ? parseBilling(costResp) : {};
    const balance = balanceResp.success ? parseBalance(balanceResp) : moneyMetric(null, balanceResp.raw || null);
    if (balance.amount != null && balance.amount < 10000) {
        warnings.push('账户余额偏低，请关注充值或预算告警');
    }

    return {
        success: true,
        dashboard: {
            month: range.month,
            balance,
            totalCost: moneyMetric(cost.totalCost ?? null, costResp.raw || null),
            vodCost: moneyMetric(cost.vodCost ?? null, cost.vodRaw || null),
            storage: storageResp.success ? parseStorage(storageResp) : usageMetric(null, 'byte', storageResp.raw || null),
            cdnUsage: cdnResp.success ? parseCdn(cdnResp) : usageMetric(null, 'byte', cdnResp.raw || null),
            updatedAt: new Date().toISOString(),
            warnings,
        },
    };
}

function extractFirstUrl(text) {
    const m = String(text || '').match(/https?:\/\/[^\s"'<>]+/i);
    return m ? m[0] : '';
}

function extractAwemeId(text) {
    const s = String(text || '');
    const patterns = [/\/video\/(\d+)/, /aweme_id[=:](\d+)/, /modal_id[=:](\d+)/, /\/(\d{15,})/];
    for (const p of patterns) {
        const m = s.match(p);
        if (m) return m[1];
    }
    return '';
}

function extractSecUid(text) {
    const s = String(text || '');
    const m = s.match(/\/user\/([^/?#\s]+)/) || s.match(/sec_uid["']?\s*[:=]\s*["']?([^"'&#\s,}]+)/);
    return m ? decodeURIComponent(m[1]) : '';
}

function tikhubGet(path, query = {}) {
    return new Promise((resolve) => {
        const url = new URL(path, TIKHUB_BASE);
        Object.entries(query).forEach(([k, v]) => {
            if (v != null && v !== '') url.searchParams.set(k, v);
        });
        const req = https.request(url, {
            method: 'GET',
            headers: { Authorization: `Bearer ${TIKHUB_TOKEN}`, Accept: 'application/json' },
        }, (res) => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    if (res.statusCode >= 400) {
                        resolve({ success: false, error: json.message || json.detail || `TikHub HTTP ${res.statusCode}`, raw: json });
                        return;
                    }
                    resolve({ success: true, raw: json });
                } catch (e) {
                    resolve({ success: false, error: '解析 TikHub 响应失败: ' + e.message, raw: data });
                }
            });
        });
        req.on('error', e => resolve({ success: false, error: 'TikHub 请求失败: ' + e.message }));
        req.end();
    });
}

function deepFind(obj, predicate) {
    if (!obj || typeof obj !== 'object') return null;
    if (predicate(obj)) return obj;
    if (Array.isArray(obj)) {
        for (const item of obj) {
            const found = deepFind(item, predicate);
            if (found) return found;
        }
        return null;
    }
    for (const value of Object.values(obj)) {
        const found = deepFind(value, predicate);
        if (found) return found;
    }
    return null;
}

function normalizeAuthor(author) {
    if (!author || typeof author !== 'object') return null;
    const name = author.nickname || author.name || author.unique_id || author.short_id || '';
    const secUid = author.sec_uid || author.secUid || '';
    if (!name && !secUid) return null;
    const avatarSource = author.avatar_larger || author.avatar_medium || author.avatar_thumb || author.avatar || {};
    const avatarURL = Array.isArray(avatarSource.url_list) ? avatarSource.url_list[0] : (avatarSource.url || avatarSource);
    return {
        name,
        displayName: author.unique_id || author.short_id || '',
        douyinId: author.unique_id || author.short_id || '',
        secUid,
        avatarURL: typeof avatarURL === 'string' ? avatarURL : '',
    };
}

function authorFromTikHub(raw) {
    const author = deepFind(raw, obj => obj && typeof obj === 'object' && (obj.nickname || obj.sec_uid || obj.unique_id) && (obj.avatar_thumb || obj.avatar_medium || obj.short_id || obj.unique_id));
    return normalizeAuthor(author);
}

function slugCoachId(author, secUid) {
    const base = String(author?.douyinId || author?.displayName || author?.name || '')
        .toLowerCase()
        .replace(/[^a-z0-9_]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 40);
    if (base) return base.startsWith('coach_') ? base : `coach_${base}`;
    const tail = String(secUid || author?.secUid || '').replace(/[^a-zA-Z0-9]/g, '').slice(-10).toLowerCase();
    return tail ? `douyin_${tail}` : `coach_${Date.now()}`;
}

async function resolveCoachSource({ urlOrText }) {
    const input = String(urlOrText || '').trim();
    if (!input) return { success: false, error: '请填写抖音主页链接、视频链接或分享文本' };
    if (!TIKHUB_TOKEN) return { success: false, error: '未配置 TIKHUB_TOKEN，无法解析抖音来源' };

    const sourceURL = extractFirstUrl(input) || input;
    const warnings = [];
    let secUid = extractSecUid(sourceURL);
    let author = null;
    const awemeId = extractAwemeId(sourceURL);

    if (awemeId) {
        const videoResp = await tikhubGet('/api/v1/douyin/web/fetch_one_video', { aweme_id: awemeId });
        if (videoResp.success) author = authorFromTikHub(videoResp.raw);
        else warnings.push('视频解析失败：' + videoResp.error);
    }

    if (!author) {
        if (!secUid) {
            const secResp = await tikhubGet('/api/v1/douyin/web/get_sec_user_id', { url: sourceURL });
            if (secResp.success) {
                secUid = deepFind(secResp.raw, obj => typeof obj?.sec_user_id === 'string')?.sec_user_id
                    || deepFind(secResp.raw, obj => typeof obj?.secUid === 'string')?.secUid
                    || extractSecUid(JSON.stringify(secResp.raw));
            } else {
                warnings.push('主页 sec_uid 解析失败：' + secResp.error);
            }
        }
        if (secUid) {
            const postsResp = await tikhubGet('/api/v1/douyin/web/fetch_user_post_videos', { sec_user_id: secUid, count: 1, max_cursor: 0 });
            if (postsResp.success) author = authorFromTikHub(postsResp.raw);
            else warnings.push('用户公开视频读取失败：' + postsResp.error);
        }
    }

    if (!author) {
        return { success: false, error: warnings[0] || '未能从链接中解析出抖音作者信息', warnings };
    }

    const resolvedSecUid = secUid || author.secUid || '';
    const profileURL = resolvedSecUid ? `https://www.douyin.com/user/${encodeURIComponent(resolvedSecUid)}` : sourceURL;
    return {
        success: true,
        result: {
            platform: 'douyin',
            name: author.name,
            avatarURL: author.avatarURL,
            sourceURL: profileURL,
            displayName: author.displayName,
            douyinId: author.douyinId || author.displayName || '',
            secUid: resolvedSecUid,
            suggestedCoachId: slugCoachId(author, resolvedSecUid),
            confidence: author.name && (author.avatarURL || resolvedSecUid) ? 0.86 : 0.62,
            warnings,
        },
    };
}

// 测试用 - 直接返回 ApplyUpload 原始响应
async function testApplyUpload(params) {
    const version = '2018-07-17';
    const service = 'vod';
    const host = 'vod.tencentcloudapi.com';
    const timestamp = Math.floor(Date.now() / 1000);
    const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
    
    const apiParams = {
        MediaType: params.MediaType || 'mp4'
    };
    if (params.MediaName) apiParams.MediaName = params.MediaName;
    
    const payload = JSON.stringify(apiParams);
    
    const crypto = require('crypto');
    const hmacSha256 = (key, msg) => crypto.createHmac('sha256', key).update(msg).digest();
    
    const canonicalRequest = `POST\n/\n\ncontent-type:application/json; charset=utf-8\nhost:${host}\n\ncontent-type;host\n${crypto.createHash('sha256').update(payload).digest('hex')}`;
    const credentialScope = `${date}/${service}/tc3_request`;
    const stringToSign = `TC3-HMAC-SHA256\n${timestamp}\n${credentialScope}\n${crypto.createHash('sha256').update(canonicalRequest).digest('hex')}`;
    
    const secretDate = hmacSha256(Buffer.from('TC3' + VOD_SECRET_KEY), date);
    const secretService = hmacSha256(secretDate, service);
    const secretSigning = hmacSha256(secretService, 'tc3_request');
    const signature = hmacSha256(secretSigning, stringToSign).toString('hex');
    
    const authorization = `TC3-HMAC-SHA256 Credential=${VOD_SECRET_ID}/${credentialScope}, SignedHeaders=content-type;host, Signature=${signature}`;
    
    return new Promise((resolve) => {
        const options = {
            hostname: host,
            port: 443,
            path: '/',
            method: 'POST',
            headers: {
                'Authorization': authorization,
                'Content-Type': 'application/json; charset=utf-8',
                'Host': host,
                'X-TC-Action': 'ApplyUpload',
                'X-TC-Timestamp': timestamp.toString(),
                'X-TC-Version': version,
                'X-TC-Region': VOD_REGION
            }
        };
        
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                console.log('VOD 原始响应:', data);
                try {
                    const result = JSON.parse(data);
                    resolve(result);
                } catch (e) {
                    resolve({ raw: data, error: e.message });
                }
            });
        });
        
        req.on('error', (e) => {
            resolve({ error: 'VOD API 请求失败：' + e.message });
        });
        
        req.write(payload);
        req.end();
    });
}

// ============================================================
// VOD 视频上传功能
// ============================================================

async function uploadVideo(params) {
    const { fileName, fileBase64 } = params;
    
    if (!fileBase64) {
        return { success: false, error: '缺少 fileBase64 参数' };
    }
    
    try {
        if (!VOD_SECRET_ID || !VOD_SECRET_KEY) {
            return { success: false, error: '未配置 VOD_SECRET_ID 或 VOD_SECRET_KEY 环境变量' };
        }
        
        console.log('ApplyUpload 请求参数:', JSON.stringify({ MediaType: 'mp4', MediaName: fileName }));
        
        // 1. 申请上传
        const applyResult = await vodRequest('ApplyUpload', {
            MediaType: 'mp4',
            MediaName: fileName || 'video.mp4'
        });
        
        console.log('ApplyUpload 结果:', JSON.stringify(applyResult));
        
        if (!applyResult.success || !applyResult.VodSessionKey) {
            return { success: false, error: applyResult.error || 'VOD 申请上传失败' };
        }
        
        // 构建上传 URL
        const uploadUrl = `https://${applyResult.StorageBucket}.vod.${applyResult.StorageRegion}.myqcloud.com${applyResult.MediaStoragePath}?VodSessionKey=${applyResult.VodSessionKey}`;
        const fileId = applyResult.MediaStoragePath;
        
        // 2. 上传到 COS
        const videoBuffer = Buffer.from(fileBase64, 'base64');
        
        console.log('开始上传到 COS, 大小:', videoBuffer.length);
        
        const uploadResult = await new Promise((resolve) => {
            const url = new URL(uploadUrl);
            const options = {
                hostname: url.hostname,
                port: 443,
                path: url.pathname + url.search,
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/octet-stream',
                    'Content-Length': videoBuffer.length
                }
            };
            
            const req = https.request(options, (res) => {
                let data = '';
                res.on('data', (chunk) => { data += chunk; });
                res.on('end', () => {
                    console.log('COS 上传响应状态码:', res.statusCode);
                    if (res.statusCode === 200) {
                        resolve({ success: true });
                    } else {
                        resolve({ success: false, error: `上传失败：${res.statusCode}` });
                    }
                });
            });
            
            req.on('error', (e) => {
                resolve({ success: false, error: '上传失败：' + e.message });
            });
            
            req.write(videoBuffer);
            req.end();
        });
        
        if (!uploadResult.success) {
            return uploadResult;
        }
        
        console.log('COS 上传成功，FileId:', fileId);
        
        // 3. 等待转码完成
        let playUrl = '';
        for (let i = 0; i < 24; i++) {
            await new Promise(resolve => setTimeout(resolve, 5000));
            
            const mediaResult = await vodRequest('DescribeMediaInfos', {
                FileIds: [fileId],
                SubAppId: 0
            });
            
            if (mediaResult.success && mediaResult.mediaInfoSet && mediaResult.mediaInfoSet.length > 0) {
                const mediaInfo = mediaResult.mediaInfoSet[0];
                
                if (mediaInfo.transcodeSet && mediaInfo.transcodeSet.length > 0) {
                    playUrl = mediaInfo.transcodeSet[0].url || '';
                } else if (mediaInfo.mediaUrl) {
                    playUrl = mediaInfo.mediaUrl;
                }
                
                if (playUrl) {
                    console.log('转码完成，播放 URL:', playUrl);
                    break;
                }
            }
        }
        
        return {
            success: true,
            fileId: fileId,
            vodURL: playUrl,
            message: '上传成功'
        };
        
    } catch (error) {
        console.error('VOD 上传失败:', error);
        return {
            success: false,
            error: `上传失败：${error.message}`
        };
    }
}

// ============================================================
// 数据迁移：为现有数据补充新字段默认值
// ============================================================

async function migrateAddNewFields() {
    const RESERVED_TAGS = ['官方合作', '官方', '精选', '精选教练', '官方合作教练'];
    const BASE_WEIGHTS = { official: 100, curated: 50, discovered: 10 };
    const log = { coaches: 0, videos: 0, invalidCategories: 0, cleanedTags: 0, fixedSourceType: 0 };

    const { data: categories } = await db.collection(COLLECTIONS.CATEGORIES).limit(500).get();
    const validCategoryIds = new Set(categories.map(c => c.id));
    const categoryMap = {};
    let catUpdated = 0;
    for (const cat of categories) {
        categoryMap[cat.id] = cat;
        if (cat.parentId === undefined || cat.parentId === null) {
            await db.collection(COLLECTIONS.CATEGORIES).where({ id: cat.id }).update({ parentId: '' });
            catUpdated++;
        }
    }
    log.categoriesFixed = catUpdated;

    const { data: coaches } = await db.collection(COLLECTIONS.COACHES).limit(500).get();
    const coachMap = {};
    for (const coach of coaches) {
        coachMap[coach.id] = coach;
        const updates = {};
        if (!coach.tier) updates.tier = 'curated';
        if (!coach.douyinId && coach.douyinId !== '') updates.douyinId = '';

        const tier = updates.tier || coach.tier || 'curated';
        const badges = [...(coach.badges || [])];
        const hadOfficial = badges.includes('official');
        if (tier === 'official_partner' && !hadOfficial) {
            badges.push('official');
            updates.badges = badges;
        } else if (tier !== 'official_partner' && hadOfficial) {
            updates.badges = badges.filter(b => b !== 'official');
        }

        if (Object.keys(updates).length > 0) {
            await db.collection(COLLECTIONS.COACHES).where({ id: coach.id }).update(updates);
            coachMap[coach.id] = { ...coach, ...updates };
            log.coaches++;
        }
    }

    const { data: videos } = await db.collection(COLLECTIONS.VIDEOS).limit(500).get();
    for (const video of videos) {
        const updates = {};

        const coach = video.coachId ? coachMap[video.coachId] : null;
        const coachTier = coach ? (coach.tier || 'curated') : null;

        if (coachTier === 'official_partner') {
            if (video.sourceType !== 'official') {
                updates.sourceType = 'official';
                updates.baseWeight = BASE_WEIGHTS.official;
                log.fixedSourceType++;
            }
        } else if (coachTier === 'pending') {
            if (video.sourceType !== 'discovered') {
                updates.sourceType = 'discovered';
                updates.baseWeight = BASE_WEIGHTS.discovered;
                log.fixedSourceType++;
            }
        } else if (coachTier === 'curated') {
            if (video.sourceType === 'official') {
                updates.sourceType = 'curated';
                updates.baseWeight = BASE_WEIGHTS.curated;
                log.fixedSourceType++;
            }
        }
        if (!video.sourceType && !updates.sourceType) updates.sourceType = 'curated';
        if (!video.sourceURL && video.sourceURL !== '') updates.sourceURL = '';
        if (!video.baseWeight && video.baseWeight !== 0 && !updates.baseWeight) {
            updates.baseWeight = BASE_WEIGHTS[updates.sourceType || video.sourceType || 'curated'] || 50;
        }

        if (video.categoryId && !validCategoryIds.has(video.categoryId)) {
            updates.categoryId = '';
            updates.parentCategoryId = '';
            log.invalidCategories++;
        }

        const effectiveCatId = updates.categoryId !== undefined ? updates.categoryId : video.categoryId;
        if (effectiveCatId && categoryMap[effectiveCatId]) {
            const expectedParent = categoryMap[effectiveCatId].parentId || '';
            if (video.parentCategoryId !== expectedParent) {
                updates.parentCategoryId = expectedParent;
            }
        }
        if (video.parentCategoryId === undefined || video.parentCategoryId === null) {
            if (updates.parentCategoryId === undefined) updates.parentCategoryId = '';
        }

        const currentTags = video.tags || [];
        const cleanedTags = currentTags.filter(t => !RESERVED_TAGS.includes(t));
        if (cleanedTags.length !== currentTags.length) {
            updates.tags = cleanedTags;
            log.cleanedTags++;
        }

        if (Object.keys(updates).length > 0) {
            await db.collection(COLLECTIONS.VIDEOS).where({ videoId: video.videoId }).update(updates);
            log.videos++;

            const finalSourceType = updates.sourceType || video.sourceType || 'curated';
            const finalBaseWeight = updates.baseWeight || video.baseWeight || BASE_WEIGHTS[finalSourceType];
            const stats = video.stats || {};
            const engagement = (stats.likes || 0) * 1 + (stats.favorites || 0) * 3 + (stats.comments || 0) * 2;
            await db.collection(COLLECTIONS.VIDEOS).where({ videoId: video.videoId }).update({
                'stats.score': finalBaseWeight + engagement
            });
        }
    }

    return {
        success: true,
        message: `迁移完成：${log.coaches} 个教练已更新，${log.videos} 个视频已更新`,
        details: {
            fixedSourceType: log.fixedSourceType,
            invalidCategoriesCleared: log.invalidCategories,
            reservedTagsCleaned: log.cleanedTags,
            categoriesFixedParentId: log.categoriesFixed || 0
        }
    };
}

async function migrateBackfillVodFileIds() {
    const { data: videos } = await db.collection(COLLECTIONS.VIDEOS).limit(500).get();
    const needFill = videos.filter(v => v.vodURL && (!v.vodFileId || v.vodFileId === ''));
    if (needFill.length === 0) {
        return { success: true, message: '所有视频已有 vodFileId，无需回填', matched: 0, total: videos.length };
    }

    const urlToVideoId = {};
    for (const v of needFill) {
        urlToVideoId[v.vodURL] = v.videoId;
    }

    const urlToFileId = {};
    let offset = 0;
    const pageSize = 20;
    while (true) {
        const searchResult = await vodRequest('SearchMedia', {
            Offset: offset,
            Limit: pageSize,
            Sort: { Field: 'CreateTime', Order: 'Desc' }
        });
        if (!searchResult.success) {
            return { success: false, error: 'SearchMedia 失败: ' + (searchResult.error || JSON.stringify(searchResult)) };
        }
        const mediaInfoSet = searchResult.MediaInfoSet || [];
        if (mediaInfoSet.length === 0) break;

        const fileIds = mediaInfoSet.map(m => m.FileId);
        const detailResult = await vodRequest('DescribeMediaInfos', { FileIds: fileIds });
        if (detailResult.success && detailResult.MediaInfoSet) {
            for (const info of detailResult.MediaInfoSet) {
                const fid = info.FileId;
                if (info.BasicInfo?.MediaUrl) urlToFileId[info.BasicInfo.MediaUrl] = fid;
                const transcodeSet = (info.TranscodeInfo?.TranscodeSet) || [];
                for (const t of transcodeSet) {
                    if (t.Url) urlToFileId[t.Url] = fid;
                }
            }
        }

        if (mediaInfoSet.length < pageSize) break;
        offset += pageSize;
    }

    let matched = 0;
    for (const v of needFill) {
        const fid = urlToFileId[v.vodURL];
        if (fid) {
            await db.collection(COLLECTIONS.VIDEOS).where({ videoId: v.videoId }).update({ vodFileId: fid });
            matched++;
        }
    }

    return {
        success: true,
        message: `回填完成：${matched}/${needFill.length} 个视频已匹配 VOD FileID`,
        matched,
        total: needFill.length,
        vodFilesScanned: Object.keys(urlToFileId).length
    };
}

// ============================================================
// 批量删除视频
// ============================================================
async function batchDeleteVideos({ videoIds }) {
    if (!videoIds || !Array.isArray(videoIds) || videoIds.length === 0) {
        return { success: false, error: '缺少 videoIds 数组' };
    }
    let deleted = 0;
    for (const videoId of videoIds) {
        await db.collection(COLLECTIONS.VIDEOS).where({ videoId })
            .update({ deleted: true, deletedAt: new Date() });
        await db.collection(COLLECTIONS.LIKES).where({ videoId }).remove();
        await db.collection(COLLECTIONS.FAVORITES).where({ videoId }).remove();
        await db.collection(COLLECTIONS.COMMENTS).where({ videoId }).remove();
        deleted++;
    }
    return { success: true, message: `已批量删除 ${deleted} 个视频`, deleted };
}

// ============================================================
// 批量填充缺失封面
// ============================================================
async function batchFillCovers() {
    const { data: videos } = await db.collection(COLLECTIONS.VIDEOS)
        .where({ deleted: _.neq(true) })
        .limit(500).get();

    const needCover = videos.filter(v => (!v.coverURL || v.coverURL === '') && v.vodFileId && v.vodFileId !== '');
    if (needCover.length === 0) {
        return { success: true, message: '所有有 FileID 的视频均已有封面', filled: 0 };
    }

    let filled = 0;
    for (let i = 0; i < needCover.length; i += 10) {
        const batch = needCover.slice(i, i + 10);
        const fileIds = batch.map(v => v.vodFileId);
        const result = await vodRequest('DescribeMediaInfos', { FileIds: fileIds });
        if (!result.success || !result.MediaInfoSet) continue;

        for (const info of result.MediaInfoSet) {
            const coverUrl = info.BasicInfo?.CoverUrl;
            if (!coverUrl) continue;
            const video = batch.find(v => v.vodFileId === info.FileId);
            if (video) {
                await db.collection(COLLECTIONS.VIDEOS)
                    .where({ videoId: video.videoId })
                    .update({ coverURL: coverUrl });
                filled++;
            }
        }
    }

    return { success: true, message: `已为 ${filled}/${needCover.length} 个视频填充封面`, filled, total: needCover.length };
}

// ============================================================
// 数据健康报告
// ============================================================
async function getDataHealthReport() {
    const { data: allVids } = await db.collection(COLLECTIONS.VIDEOS).limit(1000).get();

    const online = allVids.filter(v => !v.deleted);
    const softDeleted = allVids.filter(v => v.deleted === true);

    const noCover = online.filter(v => !v.coverURL || v.coverURL === '');
    const noFileId = online.filter(v => !v.vodFileId || v.vodFileId === '');
    const noCategory = online.filter(v => !v.categoryId || v.categoryId === '');
    const noCoachButRequired = online.filter(v =>
        (v.sourceType === 'official' || v.sourceType === 'curated') && (!v.coachId || v.coachId === '')
    );
    const noCoverButHasFileId = online.filter(v => (!v.coverURL || v.coverURL === '') && v.vodFileId && v.vodFileId !== '');

    const pick = (arr) => arr.slice(0, 50).map(v => ({ videoId: v.videoId, title: v.title }));

    return {
        success: true,
        report: {
            totalOnline: { count: online.length },
            softDeleted: { count: softDeleted.length, items: pick(softDeleted) },
            noCover: { count: noCover.length, items: pick(noCover), fixable: noCoverButHasFileId.length },
            noFileId: { count: noFileId.length, items: pick(noFileId) },
            noCategory: { count: noCategory.length, items: pick(noCategory) },
            noCoachButRequired: { count: noCoachButRequired.length, items: pick(noCoachButRequired) }
        }
    };
}
