import { Request, Response } from 'express';
import Razorpay from 'razorpay';
import crypto from 'crypto';
import { supabase } from '../config/supabase';
import { auditLog, formatResponse, formatError } from '../utils/helpers';

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID!,
  key_secret: process.env.RAZORPAY_KEY_SECRET!,
});

function assertRazorpayConfigured() {
  if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
    throw new Error('Razorpay is not configured. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET.');
  }
}

export const createOrder = async (req: Request, res: Response) => {
  try {
    assertRazorpayConfigured();
    const user = (req as any).user;
    const { amount, billing_id } = req.body;

    let numericAmount = Number(amount);
    let receipt = `rcpt_${Date.now()}`;
    const notes: Record<string, string> = {
      user_id: user.id,
    };

    if (billing_id) {
      const { data: billing, error } = await supabase
        .from('billing')
        .select('id, amount_inr, status')
        .eq('id', billing_id)
        .eq('user_id', user.id)
        .single();

      if (error || !billing) return res.status(404).json(formatError('Invoice not found for this account.'));
      if (billing.status !== 'pending') return res.status(400).json(formatError('Only pending invoices can be paid.'));

      numericAmount = Number(billing.amount_inr || 0);
      receipt = `bill_${String(billing.id).slice(0, 20)}`;
      notes.billing_id = billing.id;
    }

    if (isNaN(numericAmount) || numericAmount <= 0) {
      return res.status(400).json(
        formatError('Invalid amount. Must be a positive number representing the INR value.')
      );
    }

    const order = await razorpay.orders.create({
      amount: Math.round(numericAmount * 100), // convert ₹ to paise
      currency: 'INR',
      receipt,
      notes,
    });
    res.json(formatResponse(order));
  } catch (error: any) {
    res.status(500).json(formatError(error.message));
  }
};

export const createPlanOrder = async (req: Request, res: Response) => {
  try {
    assertRazorpayConfigured();
    const user = (req as any).user;
    const { plan_id } = req.body;

    if (!plan_id) return res.status(400).json(formatError('plan_id is required'));

    const { data: plan, error } = await supabase
      .from('plans')
      .select('id, name, monthly_price_inr')
      .eq('id', plan_id)
      .single();

    if (error || !plan) return res.status(404).json(formatError('Plan not found'));

    const amount = Number(plan.monthly_price_inr || 0);
    if (amount <= 0) {
      return res.status(400).json(formatError('This plan does not require payment. Use change-plan instead.'));
    }

    const order = await razorpay.orders.create({
      amount: Math.round(amount * 100),
      currency: 'INR',
      receipt: `plan_${String(user.id).slice(0, 12)}_${Date.now()}`,
      notes: {
        user_id: user.id,
        plan_id,
        plan_name: plan.name,
      },
    });

    res.json(formatResponse({ order, plan }));
  } catch (error: any) {
    res.status(500).json(formatError(error.message));
  }
};

export const verifyPlanPayment = async (req: Request, res: Response) => {
  try {
    assertRazorpayConfigured();
  } catch (error: any) {
    return res.status(500).json(formatError(error.message));
  }

  const user = (req as any).user;
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature, plan_id } = req.body;

  if (!plan_id) return res.status(400).json(formatError('plan_id is required'));
  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
    return res.status(400).json(formatError('Missing Razorpay payment verification fields'));
  }

  const expectedSignature = crypto
    .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET!)
    .update(`${razorpay_order_id}|${razorpay_payment_id}`)
    .digest('hex');

  if (expectedSignature !== razorpay_signature) {
    return res.status(400).json(formatError('Invalid payment signature'));
  }

  const { data: plan, error: planError } = await supabase
    .from('plans')
    .select('id, name, monthly_price_inr')
    .eq('id', plan_id)
    .single();

  if (planError || !plan) return res.status(404).json(formatError('Plan not found'));

  try {
    const order = await razorpay.orders.fetch(razorpay_order_id);
    const expectedAmount = Math.round(Number(plan.monthly_price_inr || 0) * 100);

    if (order.notes?.user_id !== user.id || order.notes?.plan_id !== plan_id) {
      return res.status(400).json(formatError('Payment order does not match this account and plan.'));
    }

    if (Number(order.amount) !== expectedAmount) {
      return res.status(400).json(formatError('Payment amount does not match the selected plan.'));
    }
  } catch (error: any) {
    return res.status(500).json(formatError(`Unable to verify Razorpay order: ${error.message}`));
  }

  const { data, error } = await supabase
    .from('users')
    .update({ plan_id })
    .eq('id', user.id)
    .select('id, email, role, plan_id, plans(name, free_quota, price_per_100_requests, rate_limit_per_minute, monthly_price_inr)')
    .single();

  if (error) return res.status(500).json(formatError(error.message));

  await auditLog(supabase, user.id, 'plan.changed', { plan_id, plan_name: plan.name, payment_id: razorpay_payment_id });

  res.json(formatResponse(data, `Payment verified and plan changed to ${plan.name}`));
};

export const verifyPayment = async (req: Request, res: Response) => {
  try {
    assertRazorpayConfigured();
  } catch (error: any) {
    return res.status(500).json(formatError(error.message));
  }

  const user = (req as any).user;
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature, billing_id } = req.body;

  if (!billing_id) return res.status(400).json(formatError('billing_id is required'));
  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
    return res.status(400).json(formatError('Missing Razorpay payment verification fields'));
  }

  const expectedSignature = crypto
    .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET!)
    .update(`${razorpay_order_id}|${razorpay_payment_id}`)
    .digest('hex');

  if (expectedSignature !== razorpay_signature) {
    return res.status(400).json(formatError('Invalid payment signature'));
  }

  try {
    const order = await razorpay.orders.fetch(razorpay_order_id);
    if (order.notes?.user_id !== user.id || order.notes?.billing_id !== billing_id) {
      return res.status(400).json(formatError('Payment order does not match this account and invoice.'));
    }
  } catch (error: any) {
    return res.status(500).json(formatError(`Unable to verify Razorpay order: ${error.message}`));
  }

  const { data: updatedBilling, error: updateError } = await supabase
    .from('billing')
    .update({ status: 'paid', invoice_id: razorpay_payment_id })
    .eq('id', billing_id)
    .eq('user_id', user.id)
    .select()
    .single();

  if (updateError) {
    console.error('Billing update failed after payment:', updateError);
    return res.status(500).json(
      formatError('Payment received but invoice update failed. Contact support with your payment ID: ' + razorpay_payment_id)
    );
  }

  if (!updatedBilling) {
    return res.status(404).json(
      formatError('Invoice not found or does not belong to this account.')
    );
  }

  await auditLog(supabase, user.id, 'payment.verified', { billing_id, payment_id: razorpay_payment_id });
  res.json(formatResponse(updatedBilling, 'Payment verified successfully'));
};
