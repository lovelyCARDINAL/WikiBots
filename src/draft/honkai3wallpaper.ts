import axios from 'axios';
import { load } from 'cheerio';

axios.get('https://www.bh3.com/wallpapers').then(({ data }) => {
	const $ = load(data);
	const img = $('.paper-item > a').get(0)?.attribs.href;
	console.log(img);
});