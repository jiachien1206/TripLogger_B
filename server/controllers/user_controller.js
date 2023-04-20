import dotenv from 'dotenv';
dotenv.config();
import User from '../models/user_model.js';
import validator from 'validator';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import emitNewsfeedsUpdate from '../../util/emitNewsfeedUpdate.js';
import { getSocketServer } from '../../app.js';
import Cache from '../../util/cache.js';

const signup = async (req, res) => {
    const { name, email, password } = req.body;
    if (!name || !email || !password || name.length < 3) {
        return res.status(400).json({ error: 'Name, email and password are required.' });
    }
    if (!validator.isEmail(email)) {
        return res.status(400).json({ error: 'Invalid email format.' });
    }

    const isUser = await User.userExist(email);
    if (isUser) {
        return res.status(400).json({ error: 'User already exists.' });
    }
    const hash = await bcrypt.hash(password, 10);
    const user = await User.signup(name, email, hash, 'native');
    const accessToken = jwt.sign(
        {
            provider: user.provider,
            name: user.name,
            email: user.email,
            id: user._id,
        },
        process.env.TOKEN_SECRET
    );

    res.status(200).json({ data: { user, accessToken } });
};

const signin = async (req, res) => {
    const { email, password } = req.body;

    const isUser = await User.userExist(email);
    if (!isUser) {
        return res.status(400).json({ error: 'User not exists.' });
    }
    const user = await User.getUser(email);
    if (!user) {
        console.log("E-mail doesn't exist.");
        return res.status(400).json({ error: "E-mail doesn't exist." });
    }
    const hash = user.password;
    const isValid = await bcrypt.compare(password, hash);
    if (!isValid) {
        res.status(403).json({
            errors: 'Password is not valid.',
        });
    }

    const accessToken = jwt.sign(
        {
            provider: user.provider,
            name: user.name,
            email: user.email,
            id: user._id,
        },
        process.env.TOKEN_SECRET
    );
    return res.status(200).json({ data: { user, accessToken } });
};

const newsfeedUpdateNotify = async (req, res) => {
    const io = getSocketServer();
    emitNewsfeedsUpdate(io);
    res.send('Emitted notification');
};

const generateUserNewsfeed = async (req, res) => {
    const userId = req.user.id;
    const user = await User.queryUser(userId);
    const locationScoreSum = Object.values(user.location_score).reduce(
        (acc, score) => acc + score,
        0
    );
    const catScoreSum = Object.values(user.tag_score).reduce((acc, score) => acc + score, 0);

    // 把每個類別的分數除以加總獲得比例*user自己預設的喜好排序
    let locationScore = {};
    for (const [key, value] of Object.entries(user.location_score)) {
        const score = user.location_pre[key] * (value / locationScoreSum);
        locationScore[key] = score;
    }
    let catScore = {};
    for (const [key, value] of Object.entries(user.tag_score)) {
        const score = user.tag_pre[key] * (value / catScoreSum);
        catScore[key] = score;
    }

    // 取出TOP1000篇文章
    const posts = await Cache.zrevrange('top-posts', 0, 999, 'WITHSCORES');
    const newsFeed = [];
    for (let i = 0; i < posts.length; i++) {
        if (!(i % 2)) {
            newsFeed.push({ post: posts[i] });
        } else {
            const location = JSON.parse(newsFeed[Math.floor(i / 2)].post).location.continent;
            const cat = JSON.parse(newsFeed[Math.floor(i / 2)].post).tags[0];
            // TOP文章分數*user對該location分數*user對該category分數
            newsFeed[Math.floor(i / 2)].score =
                Number(posts[i]) * locationScore[location] * catScore[cat];
        }
    }

    // 丟進Redis sorted set
    await Cache.del(userId);
    await Cache.zadd(
        userId,
        ...newsFeed.map(({ post, score }) => [Math.round(score * 1000000) / 1000, post])
    );
    await Cache.expire(userId, 86400);
    res.status(200).json({ message: `User ${userId} newsfeed cached.` });
};

const getUserPosts = async (req, res) => {
    const { id } = req.params;
    const posts = await User.queryUserPosts(id);
    if (posts.error) {
        return res.status(400).json({ message: "Can't find user's post." });
    }
    res.status(200).json({ data: posts });
};

const getUserVisited = async (req, res) => {
    const userId = req.user.id;
    const visitedISO3 = await User.queryUserVisited(userId);
    if (visitedISO3.error) {
        return res.status(400).json({ message: "Can't find user's visited countries." });
    }
    res.status(200).json({ data: visitedISO3 });
};

export { signup, signin, newsfeedUpdateNotify, generateUserNewsfeed, getUserPosts, getUserVisited };