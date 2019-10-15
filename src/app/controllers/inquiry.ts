/**
 * 予約照会コントローラー
 */
import * as cinerinoapi from '@cinerino/api-nodejs-client';
import * as conf from 'config';
import * as createDebug from 'debug';
import { NextFunction, Request, Response } from 'express';
import { BAD_REQUEST, CREATED, INTERNAL_SERVER_ERROR } from 'http-status';
import * as moment from 'moment-timezone';
import * as numeral from 'numeral';

import * as Text from '../../common/Const/Text';
import * as ticket from '../../common/Util/ticket';

const debug = createDebug('ttts-authentication:controllers.inquiry');

const authClient = new cinerinoapi.auth.ClientCredentials({
    domain: <string>process.env.API_AUTHORIZE_SERVER_DOMAIN,
    clientId: <string>process.env.API_CLIENT_ID,
    clientSecret: <string>process.env.API_CLIENT_SECRET,
    scopes: [],
    state: ''
});

const returnOrderTransactionService = new cinerinoapi.service.transaction.ReturnOrder4ttts({
    endpoint: <string>process.env.CINERINO_API_ENDPOINT,
    auth: authClient
});

const orderService = new cinerinoapi.service.Order({
    endpoint: <string>process.env.CINERINO_API_ENDPOINT,
    auth: authClient
});

// キャンセル料(1予約あたり1000円固定)
const CANCEL_CHARGE: number = 1000;

// 予約可能日数定義
const reserveMaxDateInfo = conf.get<{ [period: string]: number }>('reserve_max_date');

if (process.env.API_CLIENT_ID === undefined) {
    throw new Error('Please set an environment variable \'API_CLIENT_ID\'');
}

/**
 * 予約照会検索
 */
export async function search(req: Request, res: Response): Promise<void> {
    let message = '';
    let errors: ExpressValidator.Dictionary<ExpressValidator.MappedError> | null = null;

    // 照会結果セッション初期化
    delete (<Express.Session>req.session).inquiryResult;

    if (req.method === 'POST') {
        // formバリデーション
        validate(req);
        const validatorResult = await req.getValidationResult();
        errors = validatorResult.mapped();
        debug('validatorResult:', validatorResult);
        // 日付編集
        let performanceDay = req.body.day;
        performanceDay = performanceDay.replace(/\-/g, '').replace(/\//g, '');

        if (validatorResult.isEmpty()) {
            try {
                // 注文照会
                debug('inquiring...', req.body.paymentNo);
                const order = await orderService.findByOrderInquiryKey({
                    performanceDay: performanceDay,
                    paymentNo: req.body.paymentNo,
                    telephone: req.body.purchaserTel
                });
                debug('order found.', order.orderNumber);

                // 返品済であれば入力ミス
                if (order.orderStatus === cinerinoapi.factory.orderStatus.OrderReturned) {
                    throw new Error(req.__('MistakeInput'));
                }

                // 結果をセッションに保管して結果画面へ遷移
                (<Express.Session>req.session).inquiryResult = {
                    printToken: order.printToken,
                    order: order
                };
                res.redirect('/inquiry/search/result');

                return;
            } catch (error) {
                // tslint:disable-next-line:prefer-conditional-expression
                if (!(error instanceof cinerinoapi.factory.errors.NotFound)) {
                    message = req.__('MistakeInput');
                } else {
                    message = error.message;
                }
            }
        }
    }

    const maxDate = moment();
    Object.keys(reserveMaxDateInfo).forEach((key) => {
        maxDate.add(reserveMaxDateInfo[key], <moment.unitOfTime.DurationConstructor>key);
    });
    const reserveMaxDate: string = maxDate.format('YYYY/MM/DD');

    // 予約照会画面描画
    res.render('inquiry/search', {
        message: message,
        errors: errors,
        event: {
            start: moment(),
            end: reserveMaxDate
        },
        reserveMaxDate: reserveMaxDate,
        layout: 'layouts/inquiry/layout'
    });
}

/**
 * 予約照会結果画面(getのみ)
 */
export async function result(req: Request, res: Response, next: NextFunction): Promise<void> {
    const messageNotFound: string = req.__('NotFound');

    try {
        if (req === null) {
            next(new Error(messageNotFound));
        }

        const inquiryResult = (<Express.Session>req.session).inquiryResult;
        if (inquiryResult === undefined) {
            throw new Error(messageNotFound);
        }

        const reservations = inquiryResult.order.acceptedOffers.map((o) => {
            const unitPrice = ticket.getUnitPriceByAcceptedOffer(o);

            return {
                ...<cinerinoapi.factory.order.IReservation>o.itemOffered,
                unitPrice: unitPrice
            };
        })
            .sort(
                (a, b) => (a.reservedTicket.ticketType.identifier < b.reservedTicket.ticketType.identifier) ? 0 : 1
            );

        // 券種ごとに合計枚数算出
        const ticketInfos = ticket.editTicketInfos(req, ticket.getTicketInfos(inquiryResult.order));
        // キャンセル料は1予約あたり1000円固定
        const cancellationFee: string = numeral(CANCEL_CHARGE).format('0,0');

        // 画面描画
        res.render('inquiry/result', {
            printToken: inquiryResult.printToken,
            order: inquiryResult.order,
            moment: moment,
            reservations: reservations,
            ticketInfos: ticketInfos,
            enableCancel: true,
            cancellationFee: cancellationFee,
            layout: 'layouts/inquiry/layout'
        });
    } catch (error) {
        next(error);
    }
}

/**
 * 予約キャンセル処理
 */
// tslint:disable-next-line:max-func-body-length
export async function cancel(req: Request, res: Response): Promise<void> {
    let order: cinerinoapi.factory.order.IOrder;

    try {
        const inquiryResult = (<Express.Session>req.session).inquiryResult;
        if (inquiryResult === undefined) {
            throw new Error(req.__('NotFound'));
        }

        order = inquiryResult.order;
    } catch (err) {
        res.status(INTERNAL_SERVER_ERROR).json({
            errors: [{
                message: err.message
            }]
        });

        return;
    }

    const cancellationFee = CANCEL_CHARGE;
    let returnOrderTransaction: { id: string };
    try {
        // キャンセルリクエスト
        returnOrderTransaction = await returnOrderTransactionService.confirm({
            performanceDay:
                moment((<cinerinoapi.factory.order.IReservation>order.acceptedOffers[0].itemOffered).reservationFor.startDate)
                    .tz('Asia/Tokyo')
                    .format('YYYYMMDD'),
            // tslint:disable-next-line:no-magic-numbers
            paymentNo: order.confirmationNumber.slice(-6),
            cancellationFee: cancellationFee,
            reason: cinerinoapi.factory.transaction.returnOrder.Reason.Customer,
            informOrderUrl: `${process.env.API_ENDPOINT}/webhooks/onReturnOrder`,
            informReservationUrl: `${process.env.API_ENDPOINT}/webhooks/onReservationCancelled`
        });
    } catch (err) {
        if (err instanceof cinerinoapi.factory.errors.Argument) {
            res.status(BAD_REQUEST).json({
                errors: [{
                    message: err.message
                }]
            });
        } else {
            res.status(INTERNAL_SERVER_ERROR).json({
                errors: [{
                    message: err.message
                }]
            });
        }

        return;
    }

    try {
        const emailAttributes: cinerinoapi.factory.creativeWork.message.email.IAttributes = {
            typeOf: cinerinoapi.factory.creativeWorkType.EmailMessage,
            sender: {
                name: conf.get<string>('email.fromname'),
                email: conf.get<string>('email.from')
            },
            toRecipient: {
                name: <string>order.customer.name,
                email: <string>order.customer.email
            },
            about: req.__('EmailTitleCan'),
            text: getCancelMail(req, order, cancellationFee)
        };

        await returnOrderTransactionService.sendEmailNotification({
            transactionId: returnOrderTransaction.id,
            emailMessageAttributes: emailAttributes
        });
        debug('email sent.');
    } catch (err) {
        // no op
        // メール送信に失敗しても、返品処理は走るので、成功
    }

    // セッションから照会結果を削除
    delete (<Express.Session>req.session).inquiryResult;

    res.status(CREATED).json(returnOrderTransaction);
}

/**
 * 予約照会画面検証
 */
function validate(req: Request): void {
    // 購入番号
    req.checkBody('paymentNo', req.__('NoInput{{fieldName}}', { fieldName: req.__('PaymentNo') })).notEmpty();
    req.checkBody('paymentNo', req.__('NoInput{{fieldName}}', { fieldName: req.__('PaymentNo') })).notEmpty();
    // 電話番号
    //req.checkBody('purchaserTel', req.__('NoInput{{fieldName}}', { fieldName: req.__('Label.Tel') })).notEmpty();
    //req.checkBody('purchaserTel', req.__('NoInput{{fieldName}}', { fieldName: req.__('Label.Tel') })).notEmpty();
    req.checkBody(
        'purchaserTel',
        req.__('Message.minLength{{fieldName}}{{min}}', { fieldName: req.__('Label.Tel'), min: '4' })
    ).len({ min: 4 });
}

/**
 * キャンセルメール本文取得
 */
function getCancelMail(
    req: Request,
    order: cinerinoapi.factory.order.IOrder,
    fee: number
): string {
    const reservations = order.acceptedOffers.map((o) => <cinerinoapi.factory.order.IReservation>o.itemOffered);
    const mail: string[] = [];
    const locale: string = (<Express.Session>req.session).locale;

    // 東京タワー TOP DECK チケットキャンセル完了のお知らせ
    mail.push(req.__('EmailTitleCan'));
    mail.push('');

    // 姓名編集: 日本語の時は"姓名"他は"名姓"
    const purchaserName = (locale === 'ja') ?
        `${order.customer.familyName} ${order.customer.givenName}` :
        `${order.customer.givenName} ${order.customer.familyName}`;
    // XXXX XXXX 様
    mail.push(req.__('EmailDestinationName{{name}}', { name: purchaserName }));
    mail.push('');

    // この度は、「東京タワー TOP DECK」のオンライン先売りチケットサービスにてご購入頂き、誠にありがとうございます。
    mail.push(req.__('EmailHead1').replace(
        '$theater_name$',
        (locale === 'ja')
            ? reservations[0].reservationFor.superEvent.location.name.ja
            : reservations[0].reservationFor.superEvent.location.name.en
    ));

    // お客様がキャンセルされましたチケットの情報は下記の通りです。
    mail.push(req.__('EmailHead2Can'));
    mail.push('');

    // 購入番号
    // tslint:disable-next-line:no-magic-numbers
    mail.push(`${req.__('PaymentNo')} : ${order.confirmationNumber.slice(-6)}`);

    // ご来塔日時
    const day: string = moment(reservations[0].reservationFor.startDate)
        .tz('Asia/Tokyo')
        .format('YYYY/MM/DD');
    const time: string = moment(reservations[0].reservationFor.startDate)
        .tz('Asia/Tokyo')
        .format('HH:mm');
    mail.push(`${req.__('EmailReserveDate')} : ${day} ${time}`);
    // 券種、枚数
    mail.push(`${req.__('TicketType')} ${req.__('TicketCount')}`);

    // 券種ごとに合計枚数算出
    const ticketInfos = ticket.editTicketInfos(req, ticket.getTicketInfos(order));
    Object.keys(ticketInfos).forEach((key: string) => {
        mail.push(ticketInfos[key].info);
    });

    // 合計金額算出
    const price = order.price;

    mail.push('-------------------------------------');
    // 合計枚数
    mail.push(req.__('EmailTotalTicketCount{{n}}', { n: order.acceptedOffers.length.toString() }));
    // 合計金額
    mail.push(`${req.__('TotalPrice')} ${req.__('{{price}} yen', { price: numeral(price).format('0,0') })}`);
    // キャンセル料
    mail.push(`${req.__('CancellationFee')} ${req.__('{{price}} yen', { price: numeral(fee).format('0,0') })}`);
    mail.push('-------------------------------------');
    mail.push('');

    // ご注意事項
    mail.push(req.__('EmailNotice2Can'));
    // ・チケット購入金額全額をチケット購入時のクレジットカードに返金した後、チケットキャンセル料【1000円】を引き落としさせていただきます。
    mail.push(req.__('EmailNotice3Can'));
    // ・チケットの再購入をされる場合は、最初のお手続きよりご購入ください。
    mail.push(req.__('EmailNotice4Can'));
    // ・チケットを再度購入されてもキャンセル料は返金いたしません。
    mail.push(req.__('EmailNotice5Can'));
    mail.push('');

    // ※よくあるご質問（ＦＡＱ）はこちら
    mail.push(req.__('EmailFAQURL'));
    mail.push((conf.get<any>('official_url_faq_by_locale'))[locale]);
    mail.push('');

    // なお、このメールは、「東京タワー トップデッキツアー」の予約システムでチケットをキャンセル…
    mail.push(req.__('EmailFoot1Can'));
    // ※尚、このメールアドレスは送信専用となっておりますでので、ご返信頂けません。
    mail.push(req.__('EmailFoot2'));
    // ご不明※な点がございましたら、下記番号までお問合わせください。
    mail.push(req.__('EmailFoot3'));
    mail.push('');

    // お問い合わせはこちら
    mail.push(req.__('EmailAccess1'));
    // TEL
    mail.push(req.__('EmailAccess2'));

    return (mail.join(Text.Common.newline));
}
